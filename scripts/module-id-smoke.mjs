// 检查实际前端产物注册的模块名与包名、配置条目一致。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { SUGGEST_GHOST_NAMESPACE } from '../lib/settings.js';
const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const { name } = JSON.parse(read('../package.json'));
assert.equal(name, 'dsh-foresight');
const registrations = [];
runInNewContext(read('../lib/client.js'), {
  window: { __ModuleLoader__: { load: ({ id }) => registrations.push(id) } },
});
assert.deepEqual(registrations, [name]);
assert.equal(SUGGEST_GHOST_NAMESPACE, name);
assert.match(read('../cordis.patch.yml'), new RegExp(`id: ${name}\\s+name: ${name}`));
console.log('✅ 模块 ID、包名、配置条目与设置命名空间一致');
