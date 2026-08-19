window.__ModuleLoader__.load({
	id: "@nanpaidashi/dsh-honcho-sync",
	factory: function(require) {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		var React = require("react");

		function TextRow(props) {
			return React.createElement("div", { style: { marginBottom: 12 } },
				React.createElement("label", { style: { display: "block", fontSize: 13, fontWeight: 600, marginBottom: 4, color: "var(--dsh-text-secondary)" } }, props.label),
				props.tooltip ? React.createElement("span", { style: { fontSize: 11, color: "var(--dsh-text-muted)", marginLeft: 6 } }, props.tooltip) : null,
				React.createElement("input", {
					type: "text", value: props.value || "",
					onChange: function(e) { props.onChange(e.target.value); },
					style: { width: "100%", padding: "6px 8px", fontSize: 13, border: "1px solid var(--dsh-border)", borderRadius: 4, background: "var(--dsh-bg-secondary)", color: "var(--dsh-text-primary)", boxSizing: "border-box" }
				})
			);
		}

		function NumberRow(props) {
			return React.createElement("div", { style: { marginBottom: 12 } },
				React.createElement("label", { style: { display: "block", fontSize: 13, fontWeight: 600, marginBottom: 4, color: "var(--dsh-text-secondary)" } }, props.label),
				props.tooltip ? React.createElement("span", { style: { fontSize: 11, color: "var(--dsh-text-muted)", marginLeft: 6 } }, props.tooltip) : null,
				React.createElement("input", {
					type: "number", value: props.value != null ? props.value : "",
					onChange: function(e) { props.onChange(e.target.value === "" ? null : Number(e.target.value)); },
					min: props.min, max: props.max, step: props.step || 1,
					style: { width: "100%", padding: "6px 8px", fontSize: 13, border: "1px solid var(--dsh-border)", borderRadius: 4, background: "var(--dsh-bg-secondary)", color: "var(--dsh-text-primary)", boxSizing: "border-box" }
				})
			);
		}

		function ToggleRow(props) {
			return React.createElement("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 } },
				React.createElement("div", null,
					React.createElement("span", { style: { fontSize: 13, fontWeight: 600, color: "var(--dsh-text-secondary)" } }, props.label),
					props.tooltip ? React.createElement("span", { style: { fontSize: 11, color: "var(--dsh-text-muted)", marginLeft: 6 } }, props.tooltip) : null
				),
				React.createElement("label", { style: { display: "flex", alignItems: "center", cursor: "pointer" } },
					React.createElement("input", {
						type: "checkbox", checked: props.checked || false,
						onChange: function(e) { props.onChange(e.target.checked); },
						style: { width: 16, height: 16, accentColor: "var(--dsh-accent)" }
					}),
					React.createElement("span", { style: { marginLeft: 8, fontSize: 13 } }, props.checked ? "ON" : "OFF")
				)
			);
		}

		function SelectRow(props) {
			return React.createElement("div", { style: { marginBottom: 12 } },
				React.createElement("label", { style: { display: "block", fontSize: 13, fontWeight: 600, marginBottom: 4, color: "var(--dsh-text-secondary)" } }, props.label),
				props.tooltip ? React.createElement("span", { style: { fontSize: 11, color: "var(--dsh-text-muted)", marginLeft: 6 } }, props.tooltip) : null,
				React.createElement("select", {
					value: props.value || "",
					onChange: function(e) { props.onChange(e.target.value); },
					style: { width: "100%", padding: "6px 8px", fontSize: 13, border: "1px solid var(--dsh-border)", borderRadius: 4, background: "var(--dsh-bg-secondary)", color: "var(--dsh-text-primary)", boxSizing: "border-box" }
				}, props.options.map(function(o) { return React.createElement("option", { key: o.value, value: o.value }, o.label); }))
			);
		}

		function HonchoSettingsPanel(props) {
			var _s = React.useState(null), settings = _s[0], setSettings = _s[1];
			var _sa = React.useState(false), saving = _sa[0], setSaving = _sa[1];
			var _st = React.useState(""), statusMsg = _st[0], setStatusMsg = _st[1];
			var _e = React.useState(""), errorMsg = _e[0], setErrorMsg = _e[1];
			var loaded = React.useRef(false);

			React.useEffect(function() {
				if (loaded.current) return;
				loaded.current = true;
				fetch("/_dsh/dsh-honcho-sync/status").then(function(r) { return r.json(); }).then(function(data) {
					if (data.ok && data.config) {
						setSettings(data.config);
					} else if (data.error) {
						setErrorMsg(data.error);
					} else {
						setErrorMsg("Failed to load settings");
					}
				}).catch(function(err) {
					setErrorMsg("Failed to load: " + err.message);
				});
			}, []);

			function saveConfig() {
				if (!settings) return;
				setSaving(true); setStatusMsg(""); setErrorMsg("");
				var fields = ["honchoUrl","workspace","userPeer","agentPeer","debounceMs","autoRecall","recallBudget","autoSync","messageMaxChars"];
				var ops = fields.filter(function(f) { return settings[f] !== undefined; })
					.map(function(f) { return { action: "configure", field: f, value: settings[f] }; });
				Promise.all(ops.map(function(op) {
					return fetch("/_dsh/dsh-honcho-sync/status", {
						method: "POST", headers: { "Content-Type": "application/json" },
						body: JSON.stringify(op)
					}).then(function(r) { return r.json(); });
				})).then(function(results) {
					var errors = results.filter(function(r) { return r.error; });
					if (errors.length > 0) { setErrorMsg(errors[0].error); return; }
					var last = results[results.length - 1];
					if (last && last.config) setSettings(last.config);
					setStatusMsg("Saved ✓");
					setTimeout(function() { setStatusMsg(""); }, 2000);
				}).catch(function(err) { setErrorMsg("Save failed: " + err.message); })
				.finally(function() { setSaving(false); });
			}

			if (errorMsg && !settings) return React.createElement("div", { style: { padding: 16, color: "var(--dsh-error)", background: "var(--dsh-bg-tertiary)", borderRadius: 8, fontSize: 13 } }, errorMsg);
			if (!settings) return React.createElement("div", { style: { padding: 16, color: "var(--dsh-text-muted)", fontSize: 13 } }, "Loading...");

			return React.createElement("div", { style: { padding: "4px 0" } },
				React.createElement(TextRow, { label: "Honcho URL", value: settings.honchoUrl, onChange: function(v) { setSettings(Object.assign(Object.assign({}, settings), { honchoUrl: v })); }, tooltip: "Honcho API base URL (e.g. http://localhost:8000)" }),
				React.createElement(TextRow, { label: "Workspace", value: settings.workspace, onChange: function(v) { setSettings(Object.assign(Object.assign({}, settings), { workspace: v })); }, tooltip: "Honcho workspace name" }),
				React.createElement(TextRow, { label: "User Peer", value: settings.userPeer, onChange: function(v) { setSettings(Object.assign(Object.assign({}, settings), { userPeer: v })); } }),
				React.createElement(TextRow, { label: "Agent Peer", value: settings.agentPeer, onChange: function(v) { setSettings(Object.assign(Object.assign({}, settings), { agentPeer: v })); } }),
				React.createElement(NumberRow, { label: "Debounce (ms)", value: settings.debounceMs, onChange: function(v) { setSettings(Object.assign(Object.assign({}, settings), { debounceMs: v })); }, min: 0, max: 30000, tooltip: "Auto-sync debounce" }),
				React.createElement(NumberRow, { label: "Recall Budget", value: settings.recallBudget, onChange: function(v) { setSettings(Object.assign(Object.assign({}, settings), { recallBudget: v })); }, min: 0, max: 10000, tooltip: "Max recall tokens" }),
				React.createElement(NumberRow, { label: "Max Chars", value: settings.messageMaxChars, onChange: function(v) { setSettings(Object.assign(Object.assign({}, settings), { messageMaxChars: v })); }, min: 1000, max: 50000, tooltip: "Max chars per message" }),
				React.createElement(SelectRow, { label: "Observation Mode", value: settings.observationMode, options: [{ value: "auto", label: "Auto" }, { value: "full", label: "Full" }, { value: "minimal", label: "Minimal" }], onChange: function(v) { setSettings(Object.assign(Object.assign({}, settings), { observationMode: v })); }, tooltip: "Context observation level" }),
				React.createElement(ToggleRow, { label: "Auto Recall", checked: settings.autoRecall, onChange: function(v) { setSettings(Object.assign(Object.assign({}, settings), { autoRecall: v })); }, tooltip: "Auto recall memories" }),
				React.createElement(ToggleRow, { label: "Auto Sync", checked: settings.autoSync, onChange: function(v) { setSettings(Object.assign(Object.assign({}, settings), { autoSync: v })); }, tooltip: "Auto sync turns" }),
				React.createElement("div", { style: { marginTop: 16, display: "flex", gap: 8, alignItems: "center" } },
					React.createElement("button", {
						onClick: saveConfig, disabled: saving,
						style: { padding: "6px 16px", fontSize: 13, background: saving ? "var(--dsh-text-muted)" : "var(--dsh-accent)", color: "#fff", border: "none", borderRadius: 4, cursor: saving ? "not-allowed" : "pointer" }
					}, saving ? "Saving..." : "Save"),
					statusMsg ? React.createElement("span", { style: { fontSize: 12, color: "var(--dsh-text-secondary)" } }, statusMsg) : null
				)
			);
		}

		function apply(ctx) {
			ctx.slots.register(
				{ name: "settings.section", id: "honcho-memory", order: 100, label: "Honcho Memory" },
				HonchoSettingsPanel
			);
		}

		exports.apply = apply;
		exports.inject = ["slots"];
		return module.exports;
	}
});
