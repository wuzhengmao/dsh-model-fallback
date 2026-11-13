window.__ModuleLoader__.load({
	id: "dsh-model-fallback",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const React = require("react");
		const h = React.createElement;
		const { useState, useEffect } = React;

		//#region 字段表：与 lib/index.js 的 Config schema 一一对应
		/**
		 * 每一项描述一个配置字段：key 与 Host 侧 schema 同名，
		 * type 决定控件形态，def 是 schema 里的默认值（仅在宿主尚未保存过时展示）。
		 */
		const FIELDS = [
			{
				key: "enabled",
				label: "启用自动降级",
				type: "boolean",
				def: true,
				hint: "关闭后所有请求原样放行，插件不干预路由。",
			},
			{
				key: "primaryProvider",
				label: "首选模型提供商",
				type: "provider",
				def: "",
				hint: "只拦截这个提供商下的模型请求。",
			},
			{
				key: "primaryModels",
				label: "需要拦截的模型",
				type: "models",
				def: [],
				providerKey: "primaryProvider",
				hint: "勾选要监控的模型；未勾选的模型原样放行。",
			},
			{
				key: "fallbackProvider",
				label: "备用模型提供商",
				type: "provider",
				def: "",
				hint: "降级时切到这个提供商。",
			},
			{
				key: "fallbackModel",
				label: "备用模型",
				type: "model",
				def: "",
				providerKey: "fallbackProvider",
				hint: "降级时改用它重发同一请求。",
			},
			{
				key: "timeoutMs",
				label: "首 token 超时（秒）",
				type: "seconds",
				def: 10000,
				min: 0,
				hint: "超过该时长仍无任何流式响应就降级；填 0 表示不启用超时降级。",
			},
			{
				key: "windowMs",
				label: "低速率统计窗口（秒）",
				type: "seconds",
				def: 30000,
				min: 1000,
				hint: "请求开始满该时长后，按累计输出估算速率。",
			},
			{
				key: "minTokensPerSecond",
				label: "最低速率阈值（token/s）",
				type: "number",
				def: 30,
				min: 0,
				hint: "窗口期满后估算速率低于该值则降级。",
			},
			{
				key: "switchBackAfterMs",
				label: "降级持续时长（秒）",
				type: "seconds",
				def: 600000,
				min: 0,
				hint: "降级满该时长后自动尝试切回首选模型（不依赖新请求触发）；若期间你手动改选了别的模型，则放弃切回。默认 600 秒。",
			},
			{
				key: "asciiTokenPerChar",
				label: "ASCII 字符 token 系数",
				type: "number",
				def: 0.3,
				min: 0.01,
				hint: "官方 usage 到达前的速率估算系数。",
			},
			{
				key: "cjkTokenPerChar",
				label: "非 ASCII 字符 token 系数",
				type: "number",
				def: 0.6,
				min: 0.01,
			},
			{
				key: "logFile",
				label: "日志文件路径",
				type: "string",
				def: "",
				hint: "绝对路径；留空只写宿主日志与控制台。排查降级行为时可填，如 D:\\logs\\dsh-model-fallback.log",
			},
		];
		//#endregion

		//#region 值编解码
		/** 把一个字段的保存值转成输入框里的文本形态。 */
		function encodeField(field, raw) {
			if (field.type === "boolean") return raw === undefined || raw === null ? field.def : raw === true;
			if (field.type === "models") {
				if (Array.isArray(raw)) return raw.slice();
				return Array.isArray(field.def) ? field.def.slice() : [];
			}
			if (field.type === "seconds") {
				const ms = raw === undefined || raw === null ? Number(field.def) : Number(raw);
				const seconds = Number.isFinite(ms) ? ms / 1000 : 0;
				return String(seconds);
			}
			if (raw === undefined || raw === null) return String(field.def);
			return String(raw);
		}

		/** 宿主保存值 → 整页草稿（全部字段的文本形态）。 */
		function readAll(value) {
			const out = {};
			for (const field of FIELDS) out[field.key] = encodeField(field, value?.[field.key]);
			return out;
		}

		/** 逗号（中英文）或换行分隔的模型名列表。 */
		function parseList(text) {
			return String(text)
				.split(/[,，\n]/)
				.map((item) => item.trim())
				.filter((item) => item !== "");
		}
		//#endregion

		//#region 样式
		const CSS = `
.dmf-form { display: flex; flex-direction: column; gap: 18px; max-width: 760px; }
.dmf-group { border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.28)); border-radius: var(--dsw-radius-lg, 10px); padding: 14px 16px; display: flex; flex-direction: column; gap: 14px; }
.dmf-group-title { margin: 0; font-size: 13px; font-weight: 600; color: var(--dsw-alias-label-primary, inherit); }
.dmf-field { display: flex; flex-direction: column; gap: 5px; }
.dmf-field-label { font-size: 13px; font-weight: 500; color: var(--dsw-alias-label-primary, inherit); }
.dmf-field-hint { margin: 0; font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-secondary, rgba(128,128,128,0.95)); }
.dmf-input { box-sizing: border-box; width: 100%; padding: 6px 9px; font: inherit; font-size: 13px; color: inherit; background: transparent; border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.35)); border-radius: var(--dsw-radius-md, 6px); }
.dmf-input:focus { outline: 2px solid var(--dsw-alias-brand-primary, #4c8dff); outline-offset: -1px; }
.dmf-input[aria-invalid="true"] { border-color: var(--dsw-alias-danger, #d9534f); }
.dmf-switch-row { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.dmf-switch-text { display: flex; flex-direction: column; gap: 4px; }
.dmf-actions { display: flex; align-items: center; gap: 10px; }
.dmf-button { padding: 6px 14px; font: inherit; font-size: 13px; border-radius: var(--dsw-radius-md, 6px); border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.35)); background: transparent; color: inherit; cursor: pointer; }
.dmf-button:disabled { opacity: 0.5; cursor: default; }
.dmf-button-primary { border-color: var(--dsw-alias-brand-primary, #4c8dff); color: var(--dsw-alias-brand-primary, #4c8dff); font-weight: 600; }
.dmf-select { box-sizing: border-box; width: 100%; padding: 6px 9px; font: inherit; font-size: 13px; color: inherit; background: transparent; border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.35)); border-radius: var(--dsw-radius-md, 6px); }
.dmf-select:focus { outline: 2px solid var(--dsw-alias-brand-primary, #4c8dff); outline-offset: -1px; }
.dmf-select option { color: #1a1a1a; background: #fff; }
.dmf-check-list { display: flex; flex-wrap: wrap; gap: 8px 18px; padding: 2px 0; }
.dmf-check-row { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; cursor: pointer; }
.dmf-body { display: flex; flex-direction: column; gap: 10px; align-items: flex-start; }
.dmf-note { margin: 0; font-size: 12px; color: var(--dsw-alias-label-secondary, rgba(128,128,128,0.95)); }
.dmf-note-warn { color: var(--dsw-alias-warning, #e6a23c); }
.dmf-error { margin: 0; font-size: 12px; color: var(--dsw-alias-danger, #d9534f); }
.dmf-summary { font-size: 13px; color: var(--dsw-alias-label-secondary, rgba(128,128,128,0.95)); }
.dmf-degraded-badge { margin-left: 6px; padding: 1px 7px; font-size: 11px; font-weight: 600; line-height: 1.6; white-space: nowrap; border: 1px solid var(--dsw-alias-warning, #e6a23c); border-radius: 999px; color: var(--dsw-alias-warning, #e6a23c); background: transparent; }
`;

		let styleInstalled = false;
		/** 只注入一次样式；与 Client run 同生命周期由模块加载器回收。 */
		function ensureStyle() {
			if (styleInstalled || typeof document === "undefined") return;
			styleInstalled = true;
			const style = document.createElement("style");
			style.dataset.dshModelFallback = "true";
			style.textContent = CSS;
			document.head.append(style);
		}
		//#endregion

		//#region 表单
		/** Host 侧 settings 命名空间名，等于 bundle 行 id。 */
		const NS = "dsh-model-fallback";

		/** 从 ctx 取内建 settings 的 remote 命名空间（dsh-api-settings-controller 提供）。 */
		function settingsRemote(ctx) {
			const tryGet = (key) => {
				try {
					return ctx.get(key);
				} catch {
					return undefined;
				}
			};
			const direct = tryGet("remote.settings");
			if (direct !== undefined) return direct;
			const alias = tryGet("remote.settings-controller");
			if (alias !== undefined) return alias;
			const remote = tryGet("remote");
			return remote?.settings ?? remote?.settingsController ?? undefined;
		}

		/**
		 * 会话 remote：只用来取 modelCatalog（提供商 / 模型目录）。
		 * 拿不到时返回 undefined，设置页退化为文本输入。
		 */
		function sessionRemote(ctx) {
			const tryGet = (key) => {
				try {
					return ctx.get(key);
				} catch {
					return undefined;
				}
			};
			const direct = tryGet("remote.session");
			if (direct !== undefined) return direct;
			const remote = tryGet("remote");
			return remote?.session ?? undefined;
		}

		/**
		 * 解开 remote 调用的响应包装。客户端 remote 把结果包成 { ok, value }，
		 * ok 为 false 时 value 是错误描述。
		 */
		function unwrapRemote(result) {
			let node = result;
			for (let guard = 0; guard < 5; guard += 1) {
				if (node === null || typeof node !== "object" || Array.isArray(node)) return node;
				if (!("ok" in node) || !("value" in node)) return node;
				if (node.ok === false) {
					const detail = node.value;
					throw new Error(typeof detail === "string" ? detail : JSON.stringify(detail));
				}
				node = node.value;
			}
			return node;
		}

		/** describe() 的返回兼容：数组、{ namespaces }，或任意一层里带 ns 的数组。 */
		function namespacesOf(result) {
			result = unwrapRemote(result);
			if (Array.isArray(result)) return result;
			if (result === null || typeof result !== "object") return [];
			if (Array.isArray(result.namespaces)) return result.namespaces;
			for (const value of Object.values(result)) {
				if (Array.isArray(value) && value.some((row) => row !== null && typeof row === "object" && typeof row.ns === "string")) {
					return value;
				}
			}
			return [];
		}

		/** describe() 原始返回的键名，用于排查形状不符。 */
		function describeShape(result) {
			if (Array.isArray(result)) return `Array(${result.length})`;
			if (result === null || typeof result !== "object") return String(result);
			return "{" + Object.keys(result).join(",") + "}";
		}

		/** 分区页图标。 */
		function SectionIcon(props) {
			const size = props?.size ?? 18;
			return h(
				"svg",
				{
					width: size,
					height: size,
					viewBox: "0 0 24 24",
					fill: "none",
					stroke: "currentColor",
					strokeWidth: 2,
					strokeLinecap: "round",
					strokeLinejoin: "round",
					"aria-hidden": "true",
				},
				h("path", { d: "M4 7h6M14 7h6" }),
				h("circle", { cx: 12, cy: 7, r: 2 }),
				h("path", { d: "M4 17h6M14 17h6" }),
				h("circle", { cx: 12, cy: 17, r: 2 }),
			);
		}

		/**
		 * 系统设置里的「模型自动降级」页。
		 *
		 * 数据来自 Host 的 settings 命名空间：describe() 读当前保存值，
		 * update(ns, patch, revision) 写回；Host 会把新配置通过 Loader 重新
		 * apply 插件，因此保存即生效。
		 */
		function ConfigSection(props) {
			const api = props.api;
			const [status, setStatus] = useState("loading");
			const [revision, setRevision] = useState(undefined);
			const [draft, setDraft] = useState(() => readAll({}));
			const [baseline, setBaseline] = useState(() => readAll({}));
			const [dirty, setDirty] = useState(false);
			const [busy, setBusy] = useState(false);
			const [message, setMessage] = useState("");
			const [invalid, setInvalid] = useState({});

			const [diag, setDiag] = useState("");
			const [catalog, setCatalog] = useState({ groups: [] });
			const catalogOf = (providerId) => {
				const group = catalog.groups.find((row) => row !== null && typeof row === "object" && row.id === providerId);
				return Array.isArray(group?.models) ? group.models : [];
			};
			const record = (rows, shape) => {
				const names = rows.map((row) => (row && typeof row.ns === "string" ? row.ns : "?")).slice(0, 12);
				setDiag(`describe 返回 ${shape}；读到 ${rows.length} 个命名空间：${names.join("、") || "（空）"}`);
			};

			const load = async (attempt = 0) => {
				if (api === undefined) {
					setStatus("error");
					setMessage("设置服务不可用：无法读取插件配置。");
					return;
				}
				try {
					const result = unwrapRemote(await api.describe());
					const rows = namespacesOf(result);
					const mine = rows.find((row) => row !== null && typeof row === "object" && row.ns === NS);
					if (mine === undefined) {
						record(rows, describeShape(result));
						// 插件刚被 Host 重新加载时，命名空间可能还没进 describe：短暂重试。
						if (attempt < 8) {
							setStatus("loading");
							window.setTimeout(() => void load(attempt + 1), 800);
							return;
						}
						setStatus("missing");
						return;
					}
					const next = readAll(mine.value);
					setRevision(mine.revision);
					setDraft(next);
					setBaseline(next);
					setDirty(false);
					setStatus("ready");
					setMessage("");
				} catch (error) {
					setStatus("error");
					setMessage(error instanceof Error ? error.message : String(error));
				}
			};

			useEffect(() => {
				void load();
				void loadCatalog();
			}, []);

			/** 拉取提供商 / 模型目录；失败就保持空列表（下拉退化为输入框）。 */
			async function loadCatalog() {
				const session = props.sessionApi;
				if (session === undefined || typeof session.modelCatalog !== "function") return;
				try {
					const response = await session.modelCatalog();
					// remote 可能包成 { ok, value }，也可能直接给 { ok, error, value }，
					// 统一剥到带 groups 的那一层。
					let node = response;
					for (let guard = 0; guard < 4; guard += 1) {
						if (node === null || typeof node !== "object") return;
						if (node.ok === false) return;
						if (node.groups !== undefined) break;
						if (node.value === undefined) return;
						node = node.value;
					}
					const groups = Array.isArray(node?.groups) ? node.groups : [];
					if (groups.length > 0) setCatalog({ groups });
				} catch {
					/* 目录拿不到时不影响表单本身 */
				}
			}

			const edit = (key, value) => {
				setDraft((prev) => ({ ...prev, [key]: value }));
				setDirty(true);
				setMessage("");
			};

			const reset = () => {
				setDraft(baseline);
				setDirty(false);
				setMessage("");
				setInvalid({});
			};

			const submit = async (event) => {
				event.preventDefault();
				if (busy || revision === undefined) return;
				const patch = {};
				const errors = [];
				const bad = {};
				for (const field of FIELDS) {
					const current = draft[field.key];
					// models 是数组：引用比较永远不等，按值比较。
					const unchanged = field.type === "models"
						? JSON.stringify(current) === JSON.stringify(baseline[field.key])
						: current === baseline[field.key];
					if (unchanged) continue;
					if (field.type === "number") {
						const value = Number(current);
						if (!Number.isFinite(value) || value < (field.min ?? 0)) {
							bad[field.key] = true;
							errors.push(`${field.label} 需要不小于 ${field.min ?? 0} 的数字`);
							continue;
						}
						patch[field.key] = value;
					} else if (field.type === "seconds") {
						const seconds = Number(current);
						const minSeconds = (field.min ?? 0) / 1000;
						if (!Number.isFinite(seconds) || seconds < minSeconds) {
							bad[field.key] = true;
							errors.push(`${field.label} 需要不小于 ${minSeconds} 秒`);
							continue;
						}
						patch[field.key] = Math.round(seconds * 1000);
					} else if (field.type === "models") {
						const value = Array.isArray(current) ? current.filter((item) => typeof item === "string" && item !== "") : [];
						if (value.length === 0) {
							bad[field.key] = true;
							errors.push(`${field.label} 至少需要勾选一个模型`);
							continue;
						}
						patch[field.key] = value;
					} else if (field.type === "boolean") {
						patch[field.key] = current === true;
					} else {
						patch[field.key] = String(current).trim();
					}
				}
				setInvalid(bad);
				if (errors.length > 0) {
					setMessage(errors.join("；"));
					return;
				}
				if (Object.keys(patch).length === 0) {
					setMessage("没有需要保存的改动。");
					return;
				}
				setBusy(true);
				setMessage("");
				try {
					await api.update(NS, patch, revision);
					setMessage("已保存，配置立即生效。");
					await load();
				} catch (error) {
					setMessage(error instanceof Error ? error.message : String(error));
				} finally {
					setBusy(false);
				}
			};

			if (status === "loading") {
				return h("p", { className: "dmf-note", role: "status" }, "正在读取配置…");
			}
			if (status === "missing") {
				return h(
					"div",
					{ className: "dmf-body" },
					h("p", { className: "dmf-note", role: "status" }, "Host 尚未暴露本插件的配置项（settings 命名空间 " + NS + " 未出现）。"),
					diag !== "" ? h("p", { className: "dmf-field-hint" }, diag) : null,
					h(
						"button",
						{
							className: "dmf-button",
							type: "button",
							onClick: () => {
								setStatus("loading");
								void load(0);
							},
						},
						"重新读取",
					),
				);
			}
			if (status === "error") {
				return h("p", { className: "dmf-error", role: "status" }, message !== "" ? message : "读取配置失败。");
			}

			const fieldNodes = FIELDS.map((field) => {
				const value = draft[field.key];
				let control;
				if (field.type === "boolean") {
					control = h("input", {
						type: "checkbox",
						checked: value === true,
						disabled: busy,
						"aria-label": field.label,
						onChange: (event) => edit(field.key, event.target.checked),
					});
				} else if (field.type === "number" || field.type === "seconds") {
					control = h("input", {
						className: "dmf-input",
						type: "number",
						step: field.type === "seconds" ? "1" : "any",
						value,
						disabled: busy,
						"aria-invalid": invalid[field.key] === true,
						"aria-label": field.label,
						onChange: (event) => edit(field.key, event.target.value),
					});
				} else if (field.type === "provider") {
					const groups = catalog.groups;
					if (groups.length === 0) {
						control = h("input", {
							className: "dmf-input",
							type: "text",
							value,
							disabled: busy,
							"aria-invalid": invalid[field.key] === true,
							"aria-label": field.label,
							onChange: (event) => edit(field.key, event.target.value),
						});
					} else {
						const options = groups.map((group) =>
							h("option", { key: group.id, value: group.id }, group.name || group.id),
						);
						if (typeof value === "string" && value !== "" && !groups.some((group) => group.id === value)) {
							options.unshift(h("option", { key: "__current", value }, `${value}（当前值，不在目录中）`));
						}
						control = h(
							"select",
							{
								className: "dmf-select",
								value,
								disabled: busy,
								"aria-label": field.label,
								onChange: (event) => edit(field.key, event.target.value),
							},
							options,
						);
					}
				} else if (field.type === "model") {
					const models = catalogOf(draft[field.providerKey]);
					if (models.length === 0) {
						control = h("input", {
							className: "dmf-input",
							type: "text",
							value,
							disabled: busy,
							"aria-invalid": invalid[field.key] === true,
							"aria-label": field.label,
							onChange: (event) => edit(field.key, event.target.value),
						});
					} else {
						const options = models.map((model) =>
							h("option", { key: model.id, value: model.id }, model.name || model.id),
						);
						if (typeof value === "string" && value !== "" && !models.some((model) => model.id === value)) {
							options.unshift(h("option", { key: "__current", value }, `${value}（当前值，不在目录中）`));
						}
						control = h(
							"select",
							{
								className: "dmf-select",
								value,
								disabled: busy,
								"aria-label": field.label,
								onChange: (event) => edit(field.key, event.target.value),
							},
							options,
						);
					}
				} else if (field.type === "models") {
					const models = catalogOf(draft[field.providerKey]);
					const selected = Array.isArray(value) ? value : [];
					if (models.length === 0) {
						control = h("input", {
							className: "dmf-input",
							type: "text",
							value: selected.join(", "),
							disabled: busy,
							"aria-invalid": invalid[field.key] === true,
							"aria-label": field.label,
							onChange: (event) => edit(field.key, parseList(event.target.value)),
						});
					} else {
						control = h(
							"div",
							{ className: "dmf-check-list" },
							models.map((model) =>
								h(
									"label",
									{ className: "dmf-check-row", key: model.id },
									h("input", {
										type: "checkbox",
										checked: selected.includes(model.id),
										disabled: busy,
										onChange: (event) => {
											const next = event.target.checked
												? [...selected, model.id]
												: selected.filter((item) => item !== model.id);
											edit(field.key, next);
										},
									}),
									h("span", null, model.name || model.id),
								),
							),
						);
					}
				} else {
					control = h("input", {
						className: "dmf-input",
						type: "text",
						value,
						disabled: busy,
						"aria-invalid": invalid[field.key] === true,
						"aria-label": field.label,
						onChange: (event) => edit(field.key, event.target.value),
					});
				}

				const text = h(
					"div",
					{ className: "dmf-switch-text" },
					h("span", { className: "dmf-field-label" }, field.label),
					field.hint !== undefined ? h("p", { className: "dmf-field-hint" }, field.hint) : null,
				);

				if (field.type === "boolean") {
					return h("div", { className: "dmf-field", key: field.key }, h("div", { className: "dmf-switch-row" }, text, control));
				}
				return h(
					"div",
					{ className: "dmf-field", key: field.key },
					h("label", { className: "dmf-field-label" }, field.label),
					control,
					field.hint !== undefined ? h("p", { className: "dmf-field-hint" }, field.hint) : null,
				);
			});

			return h(
				"div",
				{ className: "dmf-page" },
				h("p", { className: "dmf-note" },
					"首选模型超时无响应、请求失败或输出过慢时，自动切到备用模型重跑；降级满设定时长后自动尝试切回首选模型。"),
				(String(draft.primaryProvider ?? "").trim() === "" ||
					!Array.isArray(draft.primaryModels) ||
					draft.primaryModels.length === 0 ||
					String(draft.fallbackProvider ?? "").trim() === "" ||
					String(draft.fallbackModel ?? "").trim() === "")
					? h("p", { className: "dmf-note dmf-note-warn", role: "status" },
						"配置不完整：首选 provider、首选模型列表、备用 provider、备用模型四项必须都填好，插件才会生效（当前等同于未启用）。")
					: null,
				h(
					"form",
					{ className: "dmf-form", onSubmit: (event) => { void submit(event); } },
					h("section", { className: "dmf-group" }, h("h4", { className: "dmf-group-title" }, "模型路由"), fieldNodes.slice(0, 5)),
					h("section", { className: "dmf-group" }, h("h4", { className: "dmf-group-title" }, "降级判定"), fieldNodes.slice(5, 9)),
					h("section", { className: "dmf-group" }, h("h4", { className: "dmf-group-title" }, "速率估算与日志"), fieldNodes.slice(9)),
					h(
						"div",
						{ className: "dmf-actions" },
						h("button", { type: "submit", className: "dmf-button dmf-button-primary", disabled: busy || !dirty }, busy ? "保存中…" : "保存"),
						h("button", { type: "button", className: "dmf-button", disabled: busy, onClick: reset }, "重置"),
					),
					message !== "" ? h("p", { className: "dmf-note", role: "status" }, message) : null,
					h("p", { className: "dmf-note" },
						"保存后立即生效：插件会实时读取新配置，不需要重启 DeepSeek Harness，也不会清空当前的降级计时。正在进行的降级仍按旧时长走完。"),
				),
			);
		}
		//#endregion

		//#region 降级标志 + 恢复倒计时（对话框模型标签旁）
		/**
		 * 从 ctx 取 connection 服务（RPC 通道）。拿不到返回 undefined。
		 */
		function connectionOf(ctx) {
			const tryGet = (key) => {
				try {
					return ctx.get(key);
				} catch {
					return undefined;
				}
			};
			return tryGet("connection") ?? ctx.connection ?? undefined;
		}

		/**
		 * 会话模型标签旁的降级标志：接管 conversation.input.model.label 槽位，
		 * 渲染模型名，并在降级期间（placement === 'trigger'）追加「降级中 · Xs 后恢复」。
		 *
		 * 数据来源：ownerProps 给当前模型目录数据（provider / model / placement），
		 * standardProps 给 sessionId；降级状态经 typert @Remote（modelFallback/status）轮询，
		 * 每 1 秒刷新一次剩余秒数。
		 */
		function ModelFallbackBadge(conn) {
			return function Badge(props) {
				const { sessionId, provider, model, placement } = props;
				const [status, setStatus] = useState({ degraded: false, remainingMs: 0 });

				useEffect(() => {
					if (!conn || !sessionId || placement !== "trigger") return undefined;
					let alive = true;
					let timer = null;
					async function poll() {
						try {
							const raw = await conn.rpc.call("/api", "modelFallback/status", { args: { sessionId } }, undefined);
							const value = raw && typeof raw === "object" && raw.ok === true ? raw.value : undefined;
							if (alive && value && typeof value === "object") {
								setStatus({
									degraded: value.degraded === true,
									remainingMs: Number(value.remainingMs) || 0,
								});
							}
						} catch {
							/* 查询失败不打扰模型标签显示 */
						}
					}
					void poll();
					timer = setInterval(poll, 1000);
					return () => {
						alive = false;
						if (timer !== null) clearInterval(timer);
					};
				}, [sessionId, placement, conn]);

				const modelName = (model && (model.name || model.id)) || "";
				const providerName = provider && (provider.name || provider.id);

				// 非 trigger（菜单 / 选项）里保持轻量：只回显模型名，不叠加降级标志。
				if (placement !== "trigger") {
					return h(React.Fragment, null, modelName);
				}

				const seconds = Math.max(0, Math.ceil(status.remainingMs / 1000));
				return h(
					React.Fragment,
					null,
					modelName,
					status.degraded
						? h(
								"span",
								{ className: "dmf-degraded-badge", title: `已降级到 ${providerName}/${modelName}，${seconds}s 后自动切回` },
								`⚠ 降级中 · ${seconds}s 后恢复`,
							)
						: null,
				);
			};
		}
		//#endregion

		//#region 插件入口
		/** 插件名即配置项 id。 */
		const name = "dsh-model-fallback";
		/** 需要槽位服务、Host remote（settings 命名空间）与 connection（RPC 调降级状态）。 */
		const inject = ["slots", "remote", "connection"];

		/**
		 * 在系统「设置」里注册「模型自动降级」分区。
		 *
		 * 不用 plugins.row.config：那个槽位是否给表单取决于 Host 的内部判定；
		 * 自己注册 settings.section 并直接读写 settings 命名空间更直接，也和
		 * 其他插件（如 bili）的做法一致。
		 * @param ctx - 客户端根上下文。
		 */
		function apply(ctx) {
			ensureStyle();
			const api = settingsRemote(ctx);
			const sessionApi = sessionRemote(ctx);
			const conn = connectionOf(ctx);
			const label = () => "模型自动降级";
			ctx.slots.inject("settings.section.icon", () =>
				ctx.slots.register({ name: "settings.section.icon", id: NS, order: 120, label }, (props) => h(SectionIcon, props)),
			);
			ctx.slots.inject("settings.section", () =>
				ctx.slots.register({ name: "settings.section", id: NS, order: 120, label }, (props) =>
					h(ConfigSection, { ...props, api, sessionApi }),
				),
			);
			// 对话框模型标签旁叠加「降级中 · Xs 后恢复」标志（single slot，无 id/order）。
			// connection 不可用时跳过，不影响设置页。
			if (conn) {
				ctx.slots.inject("conversation.input.model.label", () =>
					ctx.slots.register({ name: "conversation.input.model.label" }, ModelFallbackBadge(conn)),
				);
			}
		}
		//#endregion

		exports.apply = apply;
		exports.inject = inject;
		exports.name = name;
		exports.ConfigSection = ConfigSection;
		return module.exports;
	},
});
