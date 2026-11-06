/**
 * `dsh-foresight/prediction-source` 投影单元：预测的「源回合身份」。
 *
 * 官方输入预测要求「最新回合已 completed」这条资格判据来自可回放的会话状态，
 * 而不是 client 的 idle 状态或 `session.seq`（后者是下一事件序号，不是回合结束
 * 事件）。因此本单元只从原生事件派生 `{turn, endSeq, endKind}`：`turn/start`
 * 立刻作废上一回合（清空 endSeq/endKind），只有同回合的 `turn/end` 才写入结束
 * 序号与结束原因。host-only：不进 client 投影表、不提供 wire view，避免把纯资格
 * 信息广播到界面。
 *
 * 契约要点：
 *  - `applyPredictionSource` 是纯同步 fold，状态是 plain JSON（可持久化缓存），
 *    无关事件必须返回同一引用（`Object.is` 让下游零工作）；
 *  - 读取只走 `registry.stateOf()`（0.2.0-rc.2 的非废弃 host 读取接口），其返回值
 *    是 live 引用：只读取字段后返回新对象，绝不就地修改；
 *  - 能力缺失一律降级为 `PredictionSourceUnavailable`，`read` 从不抛错。
 * @module dsh-foresight/prediction-source
 */

import { z } from 'zod';
import type { Context } from '@deepseek-ai/cordis';
import type { Session } from '@deepseek-ai/dsh-session';
import type {} from '@deepseek-ai/dsh-session-projection/types';

/** 本单元在 `ctx.sessionProjections` 里的键。host-only，不出现在 client 投影表。 */
export const PREDICTION_PROJECTION_KEY = 'dsh-foresight/prediction-source';

/** 源回合身份：`turn` 为当前回合；`endSeq`/`endKind` 只在同回合结束事件时写入。 */
export interface PredictionSourceState {
  readonly turn: number | null;
  readonly endSeq: number | null;
  readonly endKind: string | null;
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /**
     * host-only 的源回合身份。只并入 host fold-state 表（`SessionProjectionStateMap`），
     * 不并入 client 的 `SessionProjectionMap` —— 它没有 wire view，不参与广播。
     */
    'dsh-foresight/prediction-source': PredictionSourceState;
  }
}

/**
 * 状态校验 schema：严格形状（只认这三个字段），三字段必填、值允许 null。
 * 它同时是 `stateSchema`（校验持久化缓存能否作为 fold 的种子）与运行期读取时的
 * 形状参考 —— 缓存里的旧行若不合形，内核会丢弃并重放日志，而不是折叠出垃圾。
 */
export const predictionSourceSchema: z.ZodType<PredictionSourceState> = z.strictObject({
  turn: z.number().nullable(),
  endSeq: z.number().nullable(),
  endKind: z.string().nullable(),
});

/**
 * 空日志初值：三字段全 null（不能生成）。
 * 0.1.2 起内核调用 `init(header, inheritedEventCount)`，旧代不传参；本单元的状态
 * 完全由事件派生，与 header／继承前缀无关，因此签名保持零参，忽略两代差异。
 */
export function initPredictionSource(): PredictionSourceState {
  return { turn: null, endSeq: null, endKind: null };
}

/** 从事件载荷里读回合号；载荷不合形时返回 null（不猜测）。 */
function turnOfEventData(data: unknown): number | null {
  const turn = (data as { turn?: unknown } | null | undefined)?.turn;
  return typeof turn === 'number' ? turn : null;
}

/** 从事件载荷里读结束原因；缺失或非字符串一律记 null（未知原因≠completed）。 */
function endKindOfEventData(data: unknown): string | null {
  const reason = (data as { reason?: unknown } | null | undefined)?.reason;
  const kind = (reason as { kind?: unknown } | null | undefined)?.kind;
  return typeof kind === 'string' ? kind : null;
}

/**
 * 纯 fold：只认 `turn/start` 与「同当前回合」的 `turn/end`，其余（含属于别的回合的
 * `turn/end`）原状态不变且返回同一引用。
 * 载荷不合形的同类事件同样按「无关」处理：宁可暂时判不合格，也不写一个猜出来的回合号。
 */
export function applyPredictionSource(
  state: PredictionSourceState,
  event: { type: string; seq: number; data?: unknown },
): PredictionSourceState {
  if (event.type === 'turn/start') {
    const turn = turnOfEventData(event.data);
    if (turn === null) return state;
    // 新回合开始 ⇒ 上一完成回合立即失去资格（清 endSeq/endKind）。
    return { turn, endSeq: null, endKind: null };
  }
  if (event.type === 'turn/end') {
    const turn = turnOfEventData(event.data);
    // 只认当前回合的结束：迟到/乱序的旧回合 turn/end 不能把资格再加回来。
    if (turn === null || state.turn === null || turn !== state.turn) return state;
    return { turn: state.turn, endSeq: event.seq, endKind: endKindOfEventData(event.data) };
  }
  return state;
}

/** 合格源身份：`sessionId` 定位请求目标，`turn`/`endSeq` 是 fork 包含式边界。 */
export type PredictionSourceRead = { kind: 'ok'; sessionId: string; turn: number; endSeq: number };

/**
 * 不可用状态。四种原因对应四种可诊断的缺失，调用方按此记录
 * `source_state_unavailable` 并等待服务/状态变化后重新对账，不回退到旧推送。
 */
export type PredictionSourceUnavailable = {
  kind: 'unavailable';
  reason: 'service_absent' | 'capability_absent' | 'unit_absent' | 'ineligible';
};

/** 读取入口：`registered` 仅用于诊断（注册是否真的落地）。 */
export interface PredictionSourceAccess {
  /**
   * 单元与 registry 是否都已就绪（诊断用）。注册经 `ctx.inject` 异步落地：install
   * 返回后的同一同步块里它仍为 false；作用域卸载后回到 false。判定源资格请以
   * `read` 的结果为准。
   */
  readonly registered: boolean;
  read(session: Session): PredictionSourceRead | PredictionSourceUnavailable;
}

/**
 * registry 的宽松结构视图：跨代只依赖 `register`/`stateOf` 的存在性，不硬链接任何
 * 版本特有符号（与 src/index.ts 的「本地判据 + 擦除式引用」同一策略）。
 */
interface ProjectionRegistryView {
  register(definition: Record<string, unknown>): unknown;
  stateOf(session: Session, key: string): unknown;
  cachedSnapshot?: unknown;
}

/**
 * 经 `ctx.inject(['sessionProjections'], ...)` 安装：注册 host-only 单元，并返回
 * 读取入口。服务永不就绪（或代际形状再变）时返回降级 access —— `read` 恒为
 * `service_absent`，绝不绕过 Cordis 注入约束直接摸 `ctx.sessionProjections`。
 */
export function installPredictionSource(ctx: Context): PredictionSourceAccess {
  const installed: { registry: ProjectionRegistryView | null; unit: boolean } = {
    registry: null,
    unit: false,
  };

  // 卸载（插件/作用域销毁）后单元已不在 registry 里，诊断标志不能继续显示「已就绪」。
  ctx.effect(() => () => {
    installed.unit = false;
  });

  ctx.inject(['sessionProjections'], (projectionCtx) => {
    const candidate = (
      projectionCtx as unknown as { sessionProjections?: Partial<ProjectionRegistryView> | null }
    ).sessionProjections;
    if (candidate === undefined || candidate === null) return;
    if (typeof candidate.register !== 'function') return;
    installed.registry = candidate as ProjectionRegistryView;

    const definition: Record<string, unknown> = {
      key: PREDICTION_PROJECTION_KEY,
      init: initPredictionSource,
      apply: applyPredictionSource,
      // 新键的首版：字段或 fold 语义变化时必须同步递增，否则旧持久化行会被前向折叠。
      stateVersion: 1,
    };
    try {
      // 跨代注册，判据与 src/index.ts 相同：0.1.2 起单元形状是 `stateSchema`
      // （wire 移入 `wire.view`/`wire.viewSchema`），此前是顶层 `schema`。
      // 本单元 host-only：两代都不提供 `view`/`wire`，因此不产生 client 广播。
      if (typeof candidate.cachedSnapshot === 'function') {
        candidate.register({ ...definition, stateSchema: predictionSourceSchema });
      } else {
        candidate.register({ ...definition, schema: predictionSourceSchema });
      }
      installed.unit = true;
    } catch (error) {
      // 装载期不能让插件整体失败：降级为「单元缺席」，read 走 service_absent。
      ctx.logger.warn(
        `dsh-foresight: prediction-source projection registration failed: ${String(error)}`,
      );
    }
  });

  return {
    get registered(): boolean {
      return installed.registry !== null && installed.unit;
    },
    read(session: Session): PredictionSourceRead | PredictionSourceUnavailable {
      // read 对外承诺「任何情况下都不抛」：服务代理在作用域拆卸后可能在属性访问上
      // 抛错，`stateOf` 自身也会先物化单元（可能因 registry 拆卸而抛），所以整段兜底，
      // 统一按「服务不可用」降级 —— 调用方据此记录 source_state_unavailable 并等待重对账。
      try {
        const registry = installed.registry;
        if (registry === null) return { kind: 'unavailable', reason: 'service_absent' };
        const stateOf = registry.stateOf;
        if (typeof stateOf !== 'function') {
          return { kind: 'unavailable', reason: 'capability_absent' };
        }
        // 走 stateOf：它先把该单元物化到当前 Session 游标，晚注册也能折叠已有历史。
        // （eventAt/snapshotEvents/ownEvents 均已废弃，新调用被禁止，不得替代它。）
        const state = stateOf.call(registry, session, PREDICTION_PROJECTION_KEY);
        if (state === undefined) return { kind: 'unavailable', reason: 'unit_absent' };
        // 返回值是 live 引用：只读字段，绝不就地改写，也不把它透传出去。
        const view = state as { turn?: unknown; endSeq?: unknown; endKind?: unknown } | null;
        const turn = typeof view?.turn === 'number' ? view.turn : null;
        const endSeq = typeof view?.endSeq === 'number' ? view.endSeq : null;
        const endKind = typeof view?.endKind === 'string' ? view.endKind : null;
        // 只有「最新回合已完成」才合格；in-progress/cancelled/failed 与未知原因一样不合格。
        if (endKind !== 'completed' || endSeq === null || turn === null) {
          return { kind: 'unavailable', reason: 'ineligible' };
        }
        return { kind: 'ok', sessionId: session.id, turn, endSeq };
      } catch {
        return { kind: 'unavailable', reason: 'service_absent' };
      }
    },
  };
}

/** 请求键的字段集：源身份 + 配方版本 + 有效生成配置身份（不含任何凭据）。 */
export interface PredictionRequestKeyParts {
  sessionId: string;
  turn: number;
  endSeq: number;
  recipeVersion: number;
  provider: string;
  model: string;
  reasoningEffort: string;
  maxOutputTokens: number;
  timeoutMs: number;
}

/**
 * 字段分隔符用 U+0000 NUL：会话文本（用户输入、模型输出、工具结果）里不可能出现，
 * 因此不会出现「不同字段组合拼出同一个键」的歧义；它也不会在诊断输出里显形。
 */
const KEY_SEPARATOR = '\u0000';

/**
 * 稳定、确定性、不含凭据的请求键：live 触发与 catch_up 触发共用同一个键，
 * 于是语义去重由 host 侧一处保证（先后到达的触发复用同一记录，不重复调模型）。
 * 字段顺序固定为签名顺序，数字统一 `String()`，保证同一份输入恒得同一个键。
 */
export function predictionRequestKey(parts: PredictionRequestKeyParts): string {
  return [
    parts.sessionId,
    String(parts.turn),
    String(parts.endSeq),
    String(parts.recipeVersion),
    parts.provider,
    parts.model,
    parts.reasoningEffort,
    String(parts.maxOutputTokens),
    String(parts.timeoutMs),
  ].join(KEY_SEPARATOR);
}
