# 自定义解析服务

插件自带两个开箱即用的云端服务（MinerU 云端、PaddleOCR），其他服务——尤其是你自己部署的本地模型——通过**解析服务脚本**接入。插件不负责安装、更新或运行任何模型：本地模型更新很快，每个人的硬件和环境也不一样，部署交给你自己；插件只定义接口，负责排队、路由、产物整理和状态显示。

插件内部对所有服务一视同仁：自带的服务也是用同一套接口注册的（见 [content/providers/](../content/providers/)），没有「云端」「本地」之分。

## 快速开始

1. 在「设置 → Agent Parser → 自定义解析服务」中点「打开文件夹」。文件夹位于 Zotero 数据目录下的 `agent-parser/providers/`（例如 `~/Zotero/agent-parser/providers/`）。
2. 从 [examples/providers/](../examples/providers/) 复制一个示例进去，按需修改：
   - [`mineru-tasks-api.js`](../examples/providers/mineru-tasks-api.js)：连接自己运行的 `mineru-kit api-server`（MinerU ≥ 4）。服务没启动时文件会在队列中等待，启动后自动继续。旧版本的「本地 MinerU」设置和排队中的文件会沿用。
   - [`simple-http.js`](../examples/providers/simple-http.js)：连接任何包装成最简 HTTP 接口的模型（上传 PDF，返回 Markdown / ZIP / JSON）。文件开头的 `INSTANCES` 中每一项都是一个独立的服务，可以同时配置多个本地模型。
3. 重启 Zotero。设置页的「自定义解析服务」会列出每个脚本注册了哪些服务，或者加载时出了什么错；注册成功的服务会出现在「解析方式」和右键菜单「用 … 重新解析」中，并有自己的设置栏。

脚本拥有与插件相同的权限（可以读写文件、访问网络），只放入你信任的代码。

## 用 MinerU 部署本地服务

推荐用 MinerU 4 部署，按硬件选择解析档位：

| 硬件 | 建议档位 | 说明 |
|---|---|---|
| 只有 CPU | `basic` | 只用小模型，不需要显卡 |
| 核显（Intel / AMD / Apple 芯片） | `basic` 或 `standard` | 追求速度用 `basic`；追求质量用 `standard`，公式识别更准 |
| 独显（NVIDIA，8 GB 显存起） | `standard`，也可以尝试 `advanced` | `advanced` 更慢，对带合并单元格的复杂表格效果更好 |

以 MinerU 官方文档为准，下面是一种做法：

```sh
uv venv ~/mineru-env --python 3.12
uv pip install --python ~/mineru-env/bin/python "mineru>=4.1,<5"
# NVIDIA 独显（Linux / Windows）：改装 "mineru[full]>=4.1,<5"，使用 vLLM / LMDeploy
# Apple 芯片：可加装 MLX 推理引擎（比默认的 llama.cpp 快），启动前 export MINERU_MODEL_VLM_ENGINE=mlx
uv pip install --python ~/mineru-env/bin/python "mineru-vl-utils[mlx]"

# 把 <档位> 换成 basic、standard 或 advanced（advanced 与 standard 共用模型，下载时写 standard）
~/mineru-env/bin/mineru-kit models download --tier <档位>     # 国内可加 --source modelscope
~/mineru-env/bin/mineru-kit api-server --host 127.0.0.1 --port 8000 \
    --tier <档位> --concurrency 1 --disable-image-analysis --preload-models
```

`--tier` 是服务能接受的最高档位，例如用 `standard` 启动的服务也能处理 `basic`。有显卡时 MinerU 会自动用显卡运行小模型；要强制只用 CPU，启动前设置 `MINERU_MODEL_SMALL_BACKEND=onnx` 和 `MINERU_MODEL_ONNX_DEVICE=cpu`。

然后把 `mineru-tasks-api.js` 放进脚本文件夹，在设置里选择与服务一致的「解析档位」。服务在其他电脑上时，用 `--host 0.0.0.0 --api-key <密钥>` 启动，在设置里填上地址和 API Key。

0.1.7 及以前的完整版会把 MinerU 装在 `~/.zotero-agent-parser/mineru-env`（模型在 `~/.mineru/models`），这些文件不会被删除，把上面命令里的 `~/mineru-env` 换成这个目录即可继续使用。不再需要时删除这两个目录。

## 编写解析服务

一个脚本调用 `AgentParserProviders.register(descriptor)` 注册一个或多个服务。脚本和插件自带的服务运行在同一个作用域，可以直接使用：

| 名称 | 用途 |
|---|---|
| `AgentParserProviders` | 注册服务；辅助函数 `trimURL`、`readFile`、`poll`、`multipart`、`parseHosts`、`isAllowedURL`、`checkURL`、`localize` |
| `AgentParserHTTP` | `request`、`json`、`download`、`upload`（带超时、重试和可读的错误信息） |
| `AgentParserOutput` | `extractZip` 等 |
| `Zotero`、`IOUtils`、`PathUtils`、`fetch` 等 | Zotero 和 Firefox 的常用接口 |

多个脚本共用一个作用域，所以请把代码包在 `(function () { … })();` 里，避免全局变量互相覆盖。

### 描述对象

完整定义见 [content/providers.js](../content/providers.js) 开头的注释。常用字段：

```js
AgentParserProviders.register({
	apiVersion: 1,
	id: 'my-model',                         // 唯一；也是设置项的前缀 extensions.agentparser.providers.my-model.*
	name: { 'zh-CN': '我的模型', 'en-US': 'My model' },   // 或一个字符串
	defaultPrefs: { url: 'http://127.0.0.1:9000', concurrency: 1 },
	limits: { maxPages: 500, maxFileSize: 100 * 1024 * 1024 },   // 可选：提交前检查，超出记为「超出服务限制」
	settings: {                             // 可选：设置页中的一栏
		description: '…',
		fields: [                           // 自动绑定到上面的设置项
			{ pref: 'url', label: '服务地址：', setupFocus: true },
			{ pref: 'apiKey', label: 'API Key：', type: 'password' },
			{ pref: 'mode', label: '模式：', type: 'menulist', options: [{ value: 'fast' }, { value: 'accurate' }] },
			{ pref: 'concurrency', label: '并发任务数：', type: 'number' },
			{ pref: 'ocr', label: '强制 OCR', type: 'checkbox' },
		],
		test: true,                         // 显示「测试连接」按钮，调用 backend.test()
	},
	getConcurrency: ctx => parseInt(ctx.getPref('concurrency')) || 1,     // 可选，默认 1
	getSetupIssue: ctx => (ctx.getPref('url') ? null : { message: '未填写服务地址' }),   // 可选
	classifyError: e => (e.isNetworkError ? 'unavailable' : 'error'),    // 可选，默认 'error'
	frontMatter: info => ({ model: info.model }),                        // 可选：写入 full.md 的 parser_<名称>
	create: (ctx, variant) => new MyBackend(ctx.getPref),
});
```

`ctx` 是 `{ id, getPref(name), setPref(name, value), plugin }`，`getPref` 读写的是这个服务自己的设置项。

需要更复杂的设置界面时，可以用 `settings.fragment`（XHTML 片段）和 `settings.script`（设置页脚本），路径相对于 `rootURI`，参见自带服务的写法。

### 解析一个文件

`create()` 返回的对象需要实现 `parse(job)`：把结果放进 `job.stagingDir`——一个 Markdown 文件，加上它以相对路径引用的 `images/` 目录（也可以直接解压一个这样的 ZIP，ZIP 只有一个顶层目录时会自动展开）——然后返回一个描述解析方式的对象。插件随后会：

- 把 Markdown 整理成 `full.md`，在开头加上 Zotero 元数据的 YAML（`parser` 为服务 ID，`frontMatter()` 返回的字段写成 `parser_<名称>`）；
- 删除没被引用的图片和其他文件；
- 检查输出是否陷入重复（可用 `getFallback()` 提供换一种方式重新解析的方案）；
- 安装到附件目录，按设置添加标签、标记同步。

`job` 中常用的字段：

| 字段 | 说明 |
|---|---|
| `filePath`、`fileSize`、`sha256` | 本地 PDF |
| `uploadName` | 只含 ASCII 的文件名（`<附件键>.pdf`），用来发给服务 |
| `sourceURL` | PDF 的下载地址（如果有），服务能直接下载时可以省去上传 |
| `stagingDir`、`tempDir` | 放结果的空目录、临时目录 |
| `timeout`、`queueTimeout`、`pollInterval` | 设置中的超时和轮询间隔（毫秒） |
| `onStatus(phase, detail)` | 报告进度，`phase` 为 `preparing`、`uploading`、`pending`、`parsing`、`downloading` 之一，`detail` 如 `"3/10"` |
| `onSubmitted(remote)`、`resume` | 记录已提交的任务，Zotero 重启后可以从 `job.resume` 接着查询，不必重新提交 |
| `checkCancelled()` | 插件关闭时抛出异常，长时间等待时应定期调用 |

需要轮询的服务可以用 `AgentParserProviders.poll(job, fn)`：反复调用 `fn`，直到它返回非 `undefined` 的值，期间自动处理断线重试和超时。

### 错误与等待

`classifyError(e)` 决定一次失败怎么处理：

| 返回值 | 处理 |
|---|---|
| `'error'`（默认） | 记为解析失败，可在条目面板重试 |
| `'limit'` | 记为「超出服务限制」，重试会跳过它，条目面板提供改用其他服务的按钮 |
| `'busy'` | 文件放回队列，15 分钟后再试 |
| `'unavailable'` | 文件放回队列，并由 `getSetupIssue()` 报告原因；服务恢复后调用 `ctx.plugin.refreshSetup(ctx.id)`，排队的文件立即继续 |

`getSetupIssue(ctx)` 返回非空时，这个服务的文件都留在队列中，工具栏状态灯显示 `message`（字符串或按语言的对象）。

## 从其他插件注册

把解析服务做成独立的 Zotero 插件分发时，在插件启动时注册、关闭时注销：

```js
function register() {
	let providers = Zotero.AgentParser?.providers;
	if (providers && !providers.get('my-model')) {
		providers.register({ apiVersion: 1, id: 'my-model', rootURI, /* … */ });
	}
}

async function startup({ rootURI }) {
	// Agent Parser 可能在之后才启动，或者被停用后重新启用
	Services.obs.addObserver(register, 'agentparser-ready');
	register();
}

function shutdown() {
	Services.obs.removeObserver(register, 'agentparser-ready');
	Zotero.AgentParser?.providers.unregister('my-model');
}
```

这样注册的服务可以带自己的 Fluent 语言文件（`ftl` + `l10n`，Zotero 会自动加载插件的 `locale/` 目录），设置页片段的路径相对于 `rootURI`。服务被注销后，排队给它的文件会等它重新注册。
