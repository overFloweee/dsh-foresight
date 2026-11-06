#!/usr/bin/env node
/**
 * 宿主侧探针：扫**已安装的官方壳**（app.asar），核对插件依赖的宿主事实是否还在。
 *
 * 为什么需要它
 * ------------
 * ↑/↓ 召回依赖宿主的一个非公开 DOM 契约：输入框卡片上的 `data-composer-card` 属性，
 * 用它限定按键作用域。宿主哪天不再提供，召回会降级（改用祖先范围判定），**不报错**。
 * 插件源码只能证明「我们写了这个依赖」，证明不了「宿主还提供它」，所以这个探针直接读宿主产物：
 * 没了就显式失败。
 *
 * 用法
 * ----
 *   node scripts/probe-host.mjs [app.asar 路径]
 *   （不给路径时自动找 /Applications/DeepSeek Harness.app/Contents/Resources/app.asar）
 *
 * 退出码：0 = 全部命中（或宿主未安装，跳过）；1 = 有宿主事实丢了。
 */
import { closeSync, existsSync, openSync, readSync } from 'node:fs'

const DEFAULT_ASAR = '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar'
const UNPACKED_SUFFIX = '.unpacked'

/** 类名片段：本插件不依赖任何宿主类名，保持为空（探针逻辑保留，以后需要时在这里加）。 */
const TARGETS = []
/**
 * 类名之外的宿主契约：插件按**字符串**依赖它们，丢了同样静默。
 *
 * 每条的「丢了会怎样」都写清楚 —— 探针失败时看 role 就知道该改插件哪一处。
 */
const DOM_TARGETS = [
  {
    pkg: 'dsh-client-ui-conversation',
    file: 'lib/client.js',
    token: 'data-composer-card',
    role: '输入框卡片锚点：↑/↓ 召回靠它限定按键作用域（丢了 → 限域降级为祖先范围判定，见 recall/Overlay.tsx 的 composerScope）',
  },
]
/** 读 asar：返回 { entries, read(path) }，不依赖任何第三方库。 */
function openAsar(asarPath) {
  const fd = openSync(asarPath, 'r')
  const head = Buffer.alloc(16)
  readSync(fd, head, 0, 16, 0)
  const payloadSize = head.readUInt32LE(4)
  const headerSize = head.readUInt32LE(12)
  const headerBuf = Buffer.alloc(headerSize)
  readSync(fd, headerBuf, 0, headerSize, 16)
  const header = JSON.parse(headerBuf.toString('utf8'))
  const base = 8 + payloadSize

  const entries = new Map()
  const walk = (node, prefix) => {
    for (const [name, entry] of Object.entries(node.files ?? {})) {
      const path = prefix + name
      if (entry.files) walk(entry, `${path}/`)
      else entries.set(path, entry)
    }
  }
  walk(header, '')

  const read = (path) => {
    const entry = entries.get(path)
    if (!entry) return null
    if (entry.offset === undefined) return null // unpacked：探针不处理
    const buf = Buffer.alloc(entry.size)
    readSync(fd, buf, 0, entry.size, base + Number(entry.offset))
    return buf.toString('utf8')
  }

  return { entries, read, close: () => closeSync(fd) }
}

/** 从一份 client.js 里抽出 CSS Module 类名 → 该类**所有**规则体的合并文本。 */
function collectRules(source) {
  const rules = new Map()
  const re = /\.([A-Za-z0-9_]{4,48})\{([^{}]*)\}/g
  let m
  while ((m = re.exec(source)) !== null) {
    const [cls, body] = [m[1], m[2]]
    // 同一个类可能有多条规则（例如基础规则 + 局部覆盖），合并后再找 font-size
    rules.set(cls, rules.has(cls) ? `${rules.get(cls)};${body}` : body)
  }
  return rules
}

/**
 * 扫宿主产物。
 * @returns {{ skipped: boolean, reason?: string, rows: Array, domRows: Array, missing: Array }}
 */
export function probeHost(asarPath = DEFAULT_ASAR) {
  if (!existsSync(asarPath)) {
    return { skipped: true, reason: `未找到 ${asarPath}（宿主未安装，跳过）`, rows: [], domRows: [], missing: [] }
  }

  const asar = openAsar(asarPath)
  const rows = []
  const domRows = []
  const missing = []
  try {
    for (const target of TARGETS) {
      const source = asar.read(`dsh/node_modules/@deepseek-ai/${target.pkg}/lib/client.js`)
      if (source === null) {
        missing.push({ pkg: target.pkg, token: '(整包)', detail: '读不到 client.js' })
        continue
      }
      const rules = collectRules(source)
      for (const token of target.tokens) {
        // 大小写敏感的「包含」匹配 —— 与浏览器里 [class*='…'] 的语义一致
        const hits = [...rules.keys()].filter((cls) => cls.includes(token))
        if (hits.length === 0) {
          missing.push({ pkg: target.pkg, token, detail: '宿主产物里找不到含该片段的类名' })
          rows.push({ pkg: target.pkg, token, cls: '—', hostFont: '—', override: target.override[token] ?? '—' })
          continue
        }
        for (const cls of hits) {
          const body = rules.get(cls)
          const font = /font-size:\s*([0-9.]+px)/.exec(body)?.[1]
          const weight = /font-weight:\s*([0-9]+)/.exec(body)?.[1]
          rows.push({
            pkg: target.pkg,
            token,
            cls,
            hostFont: font ?? (weight ? `weight ${weight}` : '继承'),
            override: target.override[token] ?? '—',
          })
        }
      }
    }

    /*
     * 第二类：DOM / 令牌契约。
     *
     * 不走 collectRules —— 它们不是 CSS Module 类名，而是普通字符串（属性名、
     * 自定义属性名），所以在产物里做**包含**匹配即可。丢了就是静默失效，
     * 和类名同级对待。
     */
    for (const target of DOM_TARGETS) {
      const path = `dsh/node_modules/@deepseek-ai/${target.pkg}/${target.file}`
      const source = asar.read(path)
      if (source === null) {
        missing.push({ pkg: target.pkg, token: target.token, detail: `读不到 ${target.file}` })
        domRows.push({ pkg: target.pkg, token: target.token, file: target.file, hit: false, role: target.role })
        continue
      }
      const hit = source.includes(target.token)
      if (!hit) missing.push({ pkg: target.pkg, token: target.token, detail: `${target.file} 里找不到该契约` })
      domRows.push({ pkg: target.pkg, token: target.token, file: target.file, hit, role: target.role })
    }
  } finally {
    asar.close()
  }
  return { skipped: false, rows, domRows, missing }
}

/** 表格打印（探针自带 CLI 形态时用）。 */
function printReport(result) {
  if (result.skipped) {
    console.log(`宿主侧探针：跳过 —— ${result.reason}`)
    return
  }
  console.log('宿主侧探针：插件依赖的宿主事实在已安装官方壳里的命中情况\n')
  const head = ['官方包', '类名片段', '命中的真实类名', '宿主字号', '插件覆盖']
  const widths = [30, 22, 34, 12, 14]
  const line = (cells) => cells.map((c, i) => String(c).padEnd(widths[i])).join('')
  console.log(line(head))
  console.log(widths.map((w) => '─'.repeat(w - 1) + ' ').join(''))
  for (const r of result.rows) console.log(line([r.pkg, r.token, r.cls, r.hostFont, r.override]))

  console.log('\nDOM / 令牌契约：')
  for (const r of result.domRows) {
    console.log(`  ${r.hit ? '✔' : '✖'} ${r.token.padEnd(20)} ${r.pkg}/${r.file}`)
    if (!r.hit) console.log(`      ${r.role}`)
  }

  if (result.missing.length === 0) {
    console.log('\n✓ 全部命中：插件依赖的类名与宿主契约都还在')
    return
  }
  console.log(`\n✗ ${result.missing.length} 条宿主事实在宿主里找不到了 —— 对应的功能已静默失效：`)
  for (const m of result.missing) console.log(`   · ${m.pkg}  ${m.token}  ${m.detail}`)
  console.log('\n处理：类名 → 读宿主产物里该元素的**新类名**，更新 src/companion/client/styles.ts 的选择器；')
  console.log('      契约 → 找到宿主的新属性/令牌，更新 src/client/recall 与 scripts/probe-host.mjs 的 DOM_TARGETS。')
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  const result = probeHost(process.argv[2] ?? DEFAULT_ASAR)
  printReport(result)
  process.exit(result.skipped || result.missing.length === 0 ? 0 : 1)
}
