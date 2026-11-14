/**
 * Permanent Session deletion — browser half.
 *
 * Two mounts:
 *
 *  - `sidebar.workspaces.session.menu.item` (order 500, after pin / rename /
 *    fork / archive / session-id) — the Delete row. It closes the menu and
 *    opens a confirmation dialog instead of deleting outright: the action is
 *    irreversible.
 *  - the dialog itself, rendered into its own React root on `document.body`.
 *    It is deliberately not a `shell.overlay` slot: a root of our own lets the
 *    dialog outlive the menu that opened it without borrowing the shell's
 *    overlay state, and it is sent through the same `react-dom/client` seed the
 *    shell uses.
 *
 * The Host half owns every durable effect; this file never touches storage. It
 * does drop the row afterwards, because a Session that was not live raises no
 * `session/disposed` for the row to follow.
 */
window.__ModuleLoader__.load({
	id: "dsh-session-delete",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_dom_client = require("react-dom/client");
		let react_jsx_runtime = require("react/jsx-runtime");
		let primitives = require("@deepseek-ai/dsh-client-ui-primitives");

		const jsx = react_jsx_runtime.jsx;
		const Fragment = react.Fragment;
		const useState = react.useState;
		const NS = "session-delete";
		/**
		* Document-relative on purpose: the GUI is served with `<base href="./">`,
		* so a root-absolute path would escape a sub-path deployment.
		*/
		const DELETE_ROUTE = "session-delete/delete";
		/** The one danger tint the shell lacks a variable for. */
		const DANGER = "#e5484d";

		const zh = {
			"menu.deleteSession": "删除会话…",
			"dialog.title": "永久删除这个会话？",
			"dialog.description": "「{title}」的全部消息、工具调用记录与它自己的文件都会被删除，且无法恢复。",
			"dialog.cancel": "取消",
			"dialog.confirm": "永久删除",
			"dialog.pending": "正在删除…",
			"error.active": "这个会话还在运行，先停止它再删除。",
			"error.missing": "这个会话已经不存在了。",
			"error.failed": "删除失败：{message}",
		};

		const en = {
			"menu.deleteSession": "Delete session…",
			"dialog.title": "Delete this session permanently?",
			"dialog.description": "\u201c{title}\u201d and everything it owns — messages, tool history, its files — is removed for good.",
			"dialog.cancel": "Cancel",
			"dialog.confirm": "Delete permanently",
			"dialog.pending": "Deleting…",
			"error.active": "This session is still running. Stop it first, then delete.",
			"error.missing": "This session no longer exists.",
			"error.failed": "Delete failed: {message}",
		};

		/**
		* Render one thrown value as a message.
		* @param error - anything thrown.
		* @returns a message.
		*/
		function messageOf(error) {
			return error instanceof Error ? error.message : String(error);
		}

		/**
		* Ask the Host to delete one Session, then drop its row locally.
		* @param ctx - the plugin context.
		* @param translate - the plugin namespace translator.
		* @param sessionId - the Session to delete.
		*/
		async function deleteSession(ctx, translate, sessionId) {
			const response = await fetch(new URL(DELETE_ROUTE, document.baseURI).href, {
				method: "POST",
				credentials: "same-origin",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ sessionId }),
			});
			let payload = null;
			try {
				payload = await response.json();
			} catch {
				payload = null;
			}
			if (!response.ok || payload === null || payload.ok !== true) {
				const code = payload?.error?.code;
				if (code === "session-active") throw new Error(translate("error.active"));
				if (code === "session-missing") throw new Error(translate("error.missing"));
				const detail = typeof payload?.error?.message === "string" ? payload.error.message : `HTTP ${response.status}`;
				throw new Error(translate("error.failed", { message: detail }));
			}
			// The Host answered, so the Session is gone from storage. Its row is
			// only removable here: a Session that was not live raises no event.
			const workspace = ctx.get("uiWorkspace");
			const current = workspace?.mainReference?.sessionId === sessionId;
			try {
				if (current === true) workspace.clearMain();
				ctx.get("sessions")?.handleSessionRemoved(sessionId);
			} catch (reason) {
				console.warn("[session-delete] row cleanup failed:", reason);
			}
		}

		/**
		* The confirmation dialog: in-flight and failure state live here, the
		* durable work lives in the Host route.
		* @param props - Session identity, the cancel/submit callbacks, and `t`.
		* @returns the modal.
		*/
		function DeleteConfirmDialog({ sessionId, displayTitle, onSubmit, onClose, t }) {
			const [deleting, setDeleting] = useState(false);
			const [error, setError] = useState(null);
			const close = () => {
				if (deleting) return;
				onClose();
			};
			const confirm = async () => {
				setDeleting(true);
				setError(null);
				try {
					await onSubmit(sessionId);
					onClose();
				} catch (reason) {
					setError(messageOf(reason));
					setDeleting(false);
				}
			};
			return jsx(primitives.Modal, {
				open: true,
				onClose: close,
				closeLabel: t("dialog.cancel"),
				title: t("dialog.title"),
				description: t("dialog.description", { title: displayTitle ?? sessionId }),
				footer: jsx(Fragment, {
					children: [
						jsx(primitives.Button, {
							variant: "outline",
							disabled: deleting,
							onClick: close,
							children: t("dialog.cancel"),
						}),
						jsx(primitives.Button, {
							variant: "outline",
							disabled: deleting,
							style: { color: DANGER },
							onClick: () => {
								void confirm();
							},
							children: t("dialog.confirm"),
						}),
					],
				}),
				children: [
					deleting ? jsx("div", { role: "status", children: t("dialog.pending") }) : null,
					error === null ? null : jsx("div", { role: "alert", style: { color: DANGER }, children: error }),
				],
			});
		}

		/**
		* The `sidebar.workspaces.session.menu.item` row.
		* @param props - Session identity, the menu state, and the dialog opener.
		* @returns the menu row.
		*/
		function DeleteSessionMenuItem({ sessionId, displayTitle, useMenuOpenState, requestDelete, t }) {
			const menuOpenState = useMenuOpenState === void 0 ? void 0 : useMenuOpenState();
			const setMenuOpen = menuOpenState === void 0 ? () => {} : menuOpenState[1];
			return jsx(primitives.MenuItemButton, {
				danger: true,
				icon: jsx(primitives.IconTrashOutlineRegular, { size: 14 }),
				onSelect: () => {
					setMenuOpen(false);
					requestDelete(sessionId, displayTitle);
				},
				children: t("menu.deleteSession"),
			});
		}

		const inject = ["slots", "sessions", "locale"];

		/**
		* Mount the menu row and the dialog host.
		* @param ctx - the plugin context.
		*/
		function apply(ctx) {
			const translate = ctx.locale.bind(NS);

			ctx.effect(() => {
				try {
					return ctx.locale.register(NS, { zh, en });
				} catch (reason) {
					console.warn("[session-delete] dictionary registration skipped:", reason);
					return () => {};
				}
			}, "session-delete: dictionaries");

			/** The dialog's own container, while it is open. */
			let mounted = null;

			/**
			* Open the confirmation dialog for one Session.
			* @param sessionId - the Session to delete.
			* @param displayTitle - its row title, for the copy.
			*/
			const openDialog = (sessionId, displayTitle) => {
				if (mounted !== null) return;
				const container = document.createElement("div");
				container.dataset.dshSessionDelete = "";
				document.body.append(container);
				const root = react_dom_client.createRoot(container);
				mounted = container;
				const close = () => {
					if (mounted !== container) return;
					mounted = null;
					try {
						root.unmount();
					} catch (reason) {
						console.warn("[session-delete] dialog unmount failed:", reason);
					}
					container.remove();
				};
				root.render(jsx(DeleteConfirmDialog, {
					sessionId,
					displayTitle,
					onSubmit: (id) => deleteSession(ctx, translate, id),
					onClose: close,
					t: translate,
				}));
			};

			ctx.slots.inject("sidebar.workspaces.session.menu.item", () => ctx.slots.register({
				name: "sidebar.workspaces.session.menu.item",
				id: "delete",
				order: 500,
				locale: NS,
				inject: () => ({
					requestDelete: (sessionId, displayTitle) => {
						openDialog(sessionId, typeof displayTitle === "string" ? displayTitle : void 0);
					},
				}),
			}, DeleteSessionMenuItem));
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
