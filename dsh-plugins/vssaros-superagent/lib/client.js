window.__ModuleLoader__.load({
	id: "@vssaros/dsh-superagent",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_dom = require("react-dom");
		let react_jsx_runtime = require("react/jsx-runtime");
		//#region src/navigation.ts
		/**
		* Thrown by `openKnownSession` when the host Session catalog is not ready or does not list the target Session.
		* The management panel catches it to display a localized error message.
		*/
		var SessionNavigationError = class extends Error {
			code;
			constructor(code) {
				super(code);
				this.code = code;
			}
		};
		/** Select `id` in the workspace once the catalog lists it, unless aborted first. */
		async function openKnownSession(sessions, id, open, signal) {
			if (signal.aborted) return false;
			if (sessions.list.getSnapshot().phase !== "ready" || !sessions.list.getSnapshot().byId[id]) await sessions.refresh();
			if (signal.aborted) return false;
			const list = sessions.list.getSnapshot();
			if (list.phase !== "ready") throw new SessionNavigationError("not-ready");
			if (!list.byId[id]) throw new SessionNavigationError("not-listed");
			open(id);
			return true;
		}
		//#endregion
		//#region src/client/controls.tsx
		/**
		* Context-free UI primitives styled with `--dsw-alias-*` tokens.
		* Mirrors DSH ui-primitives markup and keyboard behavior without coupling to its internal package API.
		*/
		const cx = (...names) => names.filter(Boolean).join(" ");
		const ICON_PATHS = {
			"chevron-left": "M15 5l-7 7 7 7",
			"chevron-right": "M9 5l7 7-7 7",
			"chevron-down": "M5 9l7 7 7-7",
			"chevron-up": "M5 15l7-7 7 7",
			search: "M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4",
			question: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6v.6M12 17h.01",
			plus: "M12 5v14M5 12h14",
			trash: "M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3",
			refresh: "M20 12a8 8 0 1 1-2.3-5.6M20 4v5h-5",
			clock: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7v5l3 2",
			history: "M3.5 12a8.5 8.5 0 1 0 2.5-6M3.5 4v4h4M12 8v4l3 2",
			shield: "M12 3l7 3v6c0 4.2-2.9 7.6-7 9-4.1-1.4-7-4.8-7-9V6z",
			decision: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM8.5 12.5l2.5 2.5 4.5-5",
			message: "M5 5h14a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H10l-5 4V6a1 1 0 0 1 1-1z",
			inbox: "M4 13l2.5-8h11l2.5 8M4 13v6h16v-6M4 13h5l1 2h4l1-2h5",
			hash: "M10 4L8 20M16 4l-2 16M5 9h15M4 15h15",
			filter: "M4 5h16l-6 7.5V18l-4 2v-7.5z",
			user: "M12 4a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM4 20c1.5-3.5 4.5-5 8-5s6.5 1.5 8 5",
			close: "M6 6l12 12M18 6L6 18",
			settings: "M4 7h10M18 7h2M4 17h4M12 17h8M16 5v4M10 15v4",
			external: "M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5",
			session: "M4 5h16v14H4zM8 10l3 2-3 2M13 15h3",
			stop: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM9.5 9.5h5v5h-5z",
			pause: "M9 6v12M15 6v12",
			play: "M8 5l11 7-11 7z",
			unsubscribe: "M6 16v-5a6 6 0 0 1 10-4.5M18 11v5l2 2H8M10 20h4M4 4l16 16",
			dismiss: "M4 4l16 16M9.9 5.2A9 9 0 0 1 21 12a12 12 0 0 1-2.4 3.2M6.3 6.4A12 12 0 0 0 3 12c2 4 5.5 6 9 6 1.4 0 2.7-.3 3.9-.9",
			pull: "M7 4a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM7 8v8M7 16a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM17 16a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM17 16V9a2 2 0 0 0-2-2h-4M13 5l-2 2 2 2",
			copy: "M9 9h10v11H9zM5 15V4h10",
			review: "M9 4h6v3H9zM7 5H5v15h14V5h-2M9 13l2 2 4-4",
			ask: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6v.6M12 17h.01",
			alert: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7.5v5.5M12 16.5h.01",
			running: "M12 3a9 9 0 1 0 9 9",
			blocked: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM5.6 5.6l12.8 12.8",
			queue: "M4 6h16M4 12h16M4 18h10",
			panel: "M5 5h14a1.5 1.5 0 0 1 1.5 1.5v11A1.5 1.5 0 0 1 19 19H5a1.5 1.5 0 0 1-1.5-1.5v-11A1.5 1.5 0 0 1 5 5zM15 5v14",
			send: "M12 19V5M6 11l6-6 6 6"
		};
		function Icon({ name, size = 16 }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("svg", {
				width: size,
				height: size,
				viewBox: "0 0 24 24",
				fill: "none",
				stroke: "currentColor",
				strokeWidth: 1.8,
				strokeLinecap: "round",
				strokeLinejoin: "round",
				"aria-hidden": "true",
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: ICON_PATHS[name] })
			});
		}
		function Button({ variant = "ghost", size = "md", icon, className, children, type = "button", ...rest }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
				type,
				className: cx("dt-btn", `dt-btn-${variant}`, `dt-btn-${size}`, className),
				...rest,
				children: [icon !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: "dt-btn-icon",
					children: icon
				}), children]
			});
		}
		function Tag({ tone = "outline", title, children }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				className: "dt-tag",
				"data-tone": tone,
				title,
				children
			});
		}
		function Pill({ active, onClick, children }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
				type: "button",
				className: cx("dt-pill", active && "dt-pill-active"),
				"aria-pressed": active,
				onClick,
				children
			});
		}
		function walk(event, values, value, onChange) {
			const index = values.indexOf(value);
			const next = {
				ArrowRight: index + 1,
				ArrowLeft: index - 1,
				Home: 0,
				End: values.length - 1
			}[event.key];
			if (next === void 0) return;
			event.preventDefault();
			const target = values[(next + values.length) % values.length];
			if (target !== value) onChange(target);
			const list = event.currentTarget;
			requestAnimationFrame(() => list.querySelector("[role=\"tab\"][aria-selected=\"true\"]")?.focus());
		}
		/** Page-level tab bar that re-emits `onChange` when clicking the active tab so callers can reset to the tab root. */
		function SegmentedTabs({ items, value, onChange, label, className }) {
			const list = (0, react.useRef)(null);
			const [more, setMore] = (0, react.useState)();
			const measure = (0, react.useCallback)(() => {
				const element = list.current;
				if (!element) return;
				const start = element.scrollLeft > 1, end = element.scrollLeft + element.clientWidth < element.scrollWidth - 1;
				setMore(start && end ? "both" : start ? "start" : end ? "end" : void 0);
			}, []);
			(0, react.useEffect)(() => {
				measure();
				if (!list.current || typeof ResizeObserver === "undefined") return;
				const observer = new ResizeObserver(measure);
				observer.observe(list.current);
				for (const tab of list.current.children) observer.observe(tab);
				return () => {
					observer.disconnect();
				};
			}, [measure, items.length]);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				ref: list,
				role: "tablist",
				"aria-label": label,
				className: cx("dt-tabs", className),
				"data-more": more,
				onScroll: measure,
				style: { gridTemplateColumns: `repeat(${items.length}, minmax(0, 1fr))` },
				onKeyDown: (event) => walk(event, items.map((item) => item.value), value, onChange),
				children: items.map((item) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
					type: "button",
					role: "tab",
					id: item.id,
					"aria-controls": item.panelId,
					"aria-selected": item.value === value,
					tabIndex: item.value === value ? 0 : -1,
					className: "dt-tab",
					onClick: () => onChange(item.value),
					children: item.label
				}, item.value))
			});
		}
		function SegmentedControl({ options, value, onChange, label, disabled, className }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				role: "tablist",
				"aria-label": label,
				className: cx("dt-segmented", className),
				style: { gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` },
				onKeyDown: (event) => {
					if (!disabled) walk(event, options.map((option) => option.value), value, onChange);
				},
				children: options.map((option) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
					type: "button",
					role: "tab",
					"aria-selected": option.value === value,
					tabIndex: option.value === value ? 0 : -1,
					title: option.title,
					disabled,
					className: "dt-segment",
					onClick: () => {
						if (option.value !== value) onChange(option.value);
					},
					children: option.label
				}, option.value))
			});
		}
		function Input({ icon, className, ...rest }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
				className: cx("dt-input", className),
				children: [icon !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: "dt-input-icon",
					children: icon
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", { ...rest })]
			});
		}
		function Switch({ checked, onChange, label, className }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
				type: "button",
				role: "switch",
				"aria-checked": checked,
				"aria-label": label,
				className: cx("dt-switch", className),
				onClick: () => onChange(!checked),
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: "dt-switch-thumb" })
			});
		}
		function StateDot({ state, className }) {
			if (state === "ongoing") return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("svg", {
				className: cx("dt-spinner", className),
				"data-state": "ongoing",
				width: 14,
				height: 14,
				viewBox: "0 0 24 24",
				"aria-hidden": "true",
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("g", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("circle", {
					cx: "12",
					cy: "12",
					r: "9.5"
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("circle", {
					cx: "12",
					cy: "12",
					r: "9.5"
				})] })
			});
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				className: cx("dt-state-dot", className),
				"data-state": state,
				"aria-hidden": "true"
			});
		}
		function Dot({ state, label }) {
			const dot = /* @__PURE__ */ (0, react_jsx_runtime.jsx)(StateDot, {
				className: "dt-dot",
				state
			});
			return label ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				className: "dt-dot-wrap",
				title: label,
				role: "img",
				"aria-label": label,
				children: dot
			}) : dot;
		}
		function DisclosureRow({ icon, title, open, onToggle, collapsedContent, children }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "dt-disclosure",
				"data-open": open || void 0,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "dt-disclosure-row",
					role: "button",
					tabIndex: 0,
					"aria-expanded": open,
					"data-disclosure-row": true,
					onClick: onToggle,
					onKeyDown: (event) => {
						if (event.key === "Enter" || event.key === " ") {
							event.preventDefault();
							onToggle();
						}
					},
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							className: "dt-disclosure-lead",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "dt-disclosure-icon",
								children: icon
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "dt-disclosure-chevron",
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Icon, { name: open ? "chevron-up" : "chevron-down" })
							})]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "dt-disclosure-title",
							children: title
						}),
						!open && collapsedContent
					]
				}), open && children]
			});
		}
		const FOCUSABLE = "a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex=\"-1\"])";
		function trapTab(event, dialog) {
			const items = [...dialog.querySelectorAll("*")].filter((element) => element.matches(FOCUSABLE));
			const first = items[0], last = items.at(-1), active = document.activeElement;
			const target = event.shiftKey ? last : first;
			if (!target || !dialog.contains(active) || active === dialog || active === (event.shiftKey ? first : last)) {
				event.preventDefault();
				target?.focus();
			}
		}
		/** Accessible modal dialog with focus trapping, Escape/backdrop dismissal, and focus restoration. */
		function Modal({ open, onClose, title, closeLabel, description, footer, className, children }) {
			const dialog = (0, react.useRef)(null);
			const close = (0, react.useRef)(onClose);
			close.current = onClose;
			(0, react.useEffect)(() => {
				if (!open) return;
				const opener = document.activeElement instanceof HTMLElement ? document.activeElement : void 0;
				dialog.current?.focus();
				const onKeyDown = (event) => {
					if (event.key === "Escape") close.current();
					else if (event.key === "Tab" && dialog.current) trapTab(event, dialog.current);
				};
				document.addEventListener("keydown", onKeyDown);
				return () => {
					document.removeEventListener("keydown", onKeyDown);
					opener?.focus();
				};
			}, [open]);
			if (!open) return null;
			return (0, react_dom.createPortal)(/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "dt-modal-root",
				role: "presentation",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					className: "dt-modal-mask",
					"aria-hidden": "true",
					onClick: onClose
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					ref: dialog,
					className: cx("dt-modal", className),
					role: "dialog",
					"aria-modal": "true",
					"aria-label": title,
					tabIndex: -1,
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "dt-modal-header",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h2", { children: title }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: "dt-modal-close",
								"aria-label": closeLabel,
								onClick: onClose,
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Icon, {
									name: "close",
									size: 14
								})
							})]
						}),
						description && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: "dt-modal-description",
							children: description
						}),
						children !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: "dt-modal-body",
							children
						}),
						footer !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: "dt-modal-footer",
							children: footer
						})
					]
				})]
			}), document.body);
		}
		/** Portaled tooltip trigger supporting hover, keyboard focus, and touch toggle. */
		function InfoTip({ text, icon = "question", warn }) {
			const anchor = (0, react.useRef)(null);
			const bubble = (0, react.useRef)(null);
			const [open, setOpen] = (0, react.useState)(false);
			(0, react.useLayoutEffect)(() => {
				const target = anchor.current, element = bubble.current;
				if (!open || !target || !element) return;
				const margin = 12, gap = 8;
				const a = target.getBoundingClientRect(), b = element.getBoundingClientRect();
				const above = a.top - gap - b.height >= margin;
				element.style.left = `${Math.max(margin, Math.min(a.left + a.width / 2 - b.width / 2, window.innerWidth - margin - b.width))}px`;
				element.style.top = `${above ? a.top - gap - b.height : a.bottom + gap}px`;
				element.style.visibility = "visible";
			}, [open]);
			(0, react.useEffect)(() => {
				if (!open) return;
				const close = () => setOpen(false);
				window.addEventListener("scroll", close, true);
				window.addEventListener("resize", close);
				return () => {
					window.removeEventListener("scroll", close, true);
					window.removeEventListener("resize", close);
				};
			}, [open]);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
				ref: anchor,
				type: "button",
				className: warn ? "dt-info dt-info-warn" : "dt-info",
				"aria-label": text,
				onMouseEnter: () => setOpen(true),
				onMouseLeave: () => setOpen(false),
				onBlur: () => setOpen(false),
				onFocus: (event) => {
					if (event.currentTarget.matches(":focus-visible")) setOpen(true);
				},
				onKeyDown: (event) => {
					if (event.key === "Escape") setOpen(false);
				},
				onPointerUp: (event) => {
					if (event.pointerType === "touch") setOpen(!open);
				},
				onClick: (event) => {
					if (event.detail > 0 && event.nativeEvent.pointerType !== "touch") setOpen(false);
				},
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Icon, {
					name: icon,
					size: 14
				})
			}), open && (0, react_dom.createPortal)(/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				ref: bubble,
				role: "tooltip",
				className: "dt-tooltip",
				style: { visibility: "hidden" },
				children: text
			}), document.body)] });
		}
		//#endregion
		//#region src/admission.ts
		const ADMISSION_OPTIONS = {
			listedUnaddressed: ["inferred", "ignore"],
			unlistedAddressed: [
				"explicit",
				"inferred",
				"ignore"
			],
			unlistedUnaddressed: ["inferred", "ignore"]
		};
		/** Default admission rules (matching pre-table behavior): unaddressed messages from listed senders are inferred candidates; unlisted senders are ignored. */
		const ADMISSION_DEFAULTS = {
			listedUnaddressed: "inferred",
			unlistedAddressed: "ignore",
			unlistedUnaddressed: "ignore"
		};
		//#endregion
		//#region src/limits.ts
		/** Validation bounds shared between host schemas and management panel forms. */
		const LIMITS = {
			ruleName: 100,
			ruleInstruction: 2e3,
			evalTimeoutSeconds: {
				min: 30,
				max: 600
			},
			maxWorkers: {
				min: 1,
				max: 16
			},
			prepareCommand: 4e3,
			promptMaxChars: {
				min: 1e3,
				max: 1e6
			},
			admissionContextMaxPages: {
				min: 1,
				max: 100
			},
			admissionContextTimeoutMs: {
				min: 1,
				max: 9e4
			}
		};
		//#endregion
		//#region src/core/errors.ts
		/** User-facing error codes mapped to their category ('missing' or 'refused') and English message template. */
		const USER_ERRORS = {
			unknownTicket: ["missing", "Unknown ticket"],
			unknownProblem: ["missing", "Unavailable Eval not found"],
			notUnknownReply: ["missing", "No reply with that id waits to be redelivered"],
			unknownTrigger: ["missing", "Unknown trigger"],
			unknownAssignment: ["missing", "Unknown assignment"],
			unknownBlock: ["missing", "Unknown settings block: {block}"],
			unknownPromptRevision: ["missing", "Unknown prompt revision {revision}"],
			unknownPromptPart: ["refused", "Unknown built-in prompt part {part}"],
			ticketEnded: ["refused", "Ticket has ended"],
			notStaffing: ["refused", "This ticket does not wait for its team; its team was agreed already"],
			staleProposal: ["refused", "The agreement names another version of the team proposal; ask the person about the current one"],
			notConsent: ["refused", "Only a listed person's own message, sent on one of the ticket's threads after the proposal, can agree to or refuse a team; {why}"],
			assignmentEnded: ["refused", "Assignment has ended; a newer assignment owns this ticket"],
			evalFinished: ["refused", "Eval {eval} has finished or a later eval replaced it; decide the trigger's current eval"],
			notAdmissible: ["refused", "Trigger is not admissible: {reason}"],
			notExplicit: ["refused", "An accept through orchestrator_route is for explicit requests from allowed senders; assess proactive candidates with orchestrator_eval and orchestrator_eval_decide"],
			ticketStopped: ["refused", "A person stopped this ticket; new work needs an accept through orchestrator_route"],
			mandateRevoked: ["refused", "The current policy no longer holds this ticket's mandate; new work needs an accept through orchestrator_route"],
			notRetryable: ["refused", "Only an open ticket can be retried, and only when its worker last reported failed or blocked and no person has sent a message since, or when delivering an Input to its worker failed"],
			sourceThread: ["refused", "This is the thread the ticket started on; it stays subscribed"],
			followedThread: ["refused", "This thread is the ticket's own, such as its pull request's; it stays subscribed"],
			notFollowing: ["refused", "This ticket does not follow that thread"],
			questionWithResult: ["refused", "A question for a person cannot also be a ready result or an answer; report it separately"],
			askerWithoutQuestion: ["refused", "The message that raised a question needs the question it raised"],
			notAsker: ["refused", "A question must name the person's message that raised it, which reached this ticket"],
			notAnswerable: ["refused", "An answer must name the person's question it answers, which reached this ticket"],
			ackEnded: ["refused", "Ticket ended; do not acknowledge historical requests"],
			notReached: ["refused", "Trigger does not belong to this worker"],
			handedBack: ["refused", "This ticket handed that trigger back already"],
			handedBackHere: ["refused", "The worker of this ticket handed that trigger back as beyond it: accept it as new work, attach it to another ticket, or ignore it"],
			workerDecides: ["refused", "This message reached ticket {tickets} on its thread: its worker decides whether it belongs there and hands back what does not, which then arrives as a candidate. Only a stop goes through orchestrator_route, with kind stop"],
			ackNoChannel: ["refused", "Acknowledgement requires an assigned human source message"],
			ackNotPerson: ["refused", "Use the original human trigger, not a bot, CI or worker report"],
			notReady: ["refused", "Ticket is not ready for delivery. Keep progress internal and wait for a verified ready report; do not relabel progress as an answer or send it through another channel."],
			notAttention: ["refused", "Attention requires the ticket's current attention question in human_action. Routine unfinished work stays internal."],
			notQuestion: ["refused", "An answer must target the original human question, not a worker report or automated trigger"],
			noAnswer: ["refused", "No worker answer is ready for this human trigger. Wait for the worker's report, or request one with orchestrator_ticket_request_status, which acts only on a worker that reported waiting; ordinary progress cannot be relabelled as an answer."],
			noChannel: ["refused", "No reply channel for this ticket or trigger"],
			panelOnlyEnvironment: ["refused", "The execution environment (ticket directory, prepare command, blocked commands) can only be changed in the management panel"],
			panelOnlyAccounts: ["refused", "Source fields that setup reads, such as account CLIs, can only be changed in the management panel"],
			setupComplete: ["refused", "Setup is complete"],
			modelUnavailable: ["refused", "The {block} model is not available: {error}"],
			promptTooLong: ["refused", "Prompt configuration exceeds {limit} characters"],
			promptPlaceholders: ["refused", "The “{part}” template must keep {placeholders}, which the system fills in"],
			promptPartEmpty: ["refused", "The “{part}” part cannot be empty; reset it to follow its built-in text"],
			sourceNotInstalled: ["refused", "The {source} Source kind is not installed"],
			noLabels: ["refused", "This Source has no names to refresh"],
			nothingToSync: ["refused", "The {source} Source's part of the Policy has nothing to sync from, or the Source is off or waiting for setup"]
		};
		//#endregion
		//#region src/client/api.ts
		/** Same-origin client and polling hook for the orchestrator management API. */
		/**
		* Represents a failed management API request with a localized message and structured diagnostic details.
		* Thrown by API callers and inspected by UI views and draft state to distinguish validation issues, missing records,
		* and unreachable hosts (`details.unreachable` is set when `dsh-superagent` did not answer at all, such as during a restart,
		* in which case a 404 does not mean a record is missing).
		*/
		var ApiError = class extends Error {
			status;
			details;
			constructor(message, status, details = {}) {
				super(message);
				this.status = status;
				this.details = details;
			}
			get issues() {
				return this.details.issues ?? [];
			}
			/** True when the host confirmed the record does not exist, rather than being unreachable. */
			get missing() {
				return this.status === 404 && !this.details.unreachable;
			}
		};
		const isUserError = (code) => typeof code === "string" && Object.hasOwn(USER_ERRORS, code);
		/** Calls one management endpoint; the `x-orchestrator-request` header marks the request as originating from this page. */
		async function api(messages, path, method, body) {
			let response;
			const json = body === void 0 ? {} : {
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body)
			};
			try {
				response = await fetch(`/orchestrator/api/${path}`, {
					method,
					...json,
					headers: {
						"x-orchestrator-request": "1",
						...json.headers
					}
				});
			} catch {
				throw new ApiError(messages.offline, 0, { unreachable: true });
			}
			const text = await response.text();
			let value;
			try {
				value = text ? JSON.parse(text) : {};
			} catch {
				value = void 0;
			}
			if (!response.ok) {
				const failure = value ?? {};
				const issues = Array.isArray(failure.issues) ? failure.issues : [];
				const user = isUserError(failure.code) ? {
					code: failure.code,
					values: failure.values ?? {}
				} : void 0;
				const { status } = response;
				throw new ApiError(failure.setup ? messages.setup(failure.setup) : user ? messages.user(user) : typeof failure.error === "string" ? failure.error : !text && status === 404 ? messages.notRunning : status >= 500 ? messages.serverError(status) : messages.requestFailed(status), status, {
					issues,
					...failure.setup ? { setup: failure.setup } : {},
					...user ? { user } : {},
					...Array.isArray(failure.changed) ? { changed: failure.changed.map(String) } : {},
					...text ? {} : { unreachable: true }
				});
			}
			return value;
		}
		const HIDDEN_FACTOR = 6;
		const same$1 = (a, b) => a === b || JSON.stringify(a) === JSON.stringify(b);
		/**
		* Poll an endpoint while mounted, backing off when the document is hidden.
		* Preserves the last successful value across dependency changes and errors, skips state updates when the response is unchanged,
		* and drops stale responses when `deps` or `intervalMs` changes start a new subscription.
		*/
		function usePoll(load, deps, intervalMs = 5e3) {
			const [state, setState] = (0, react.useState)({});
			const loader = (0, react.useRef)(load);
			loader.current = load;
			const refresh = (0, react.useRef)(async () => {});
			(0, react.useEffect)(() => {
				let active = true;
				let timer;
				let queue = Promise.resolve();
				const once = async () => {
					clearTimeout(timer);
					try {
						const value = await loader.current();
						if (active) setState((previous) => same$1(previous.data, value) ? previous.error ? { data: previous.data } : previous : { data: value });
					} catch (failure) {
						if (active) setState((previous) => ({
							...previous,
							error: failure instanceof Error ? failure : new Error(String(failure))
						}));
					} finally {
						if (active) timer = setTimeout(run, document.hidden ? intervalMs * HIDDEN_FACTOR : intervalMs);
					}
				};
				const run = () => queue = queue.then(once);
				const shown = () => {
					if (!document.hidden) run();
				};
				refresh.current = run;
				run();
				document.addEventListener("visibilitychange", shown);
				return () => {
					active = false;
					clearTimeout(timer);
					document.removeEventListener("visibilitychange", shown);
				};
			}, [...deps, intervalMs]);
			const reload = (0, react.useCallback)(() => refresh.current(), []);
			return {
				data: state.data,
				error: state.error,
				reload
			};
		}
		const DECISION_FILTERS = [
			"work",
			"stop",
			"ignore",
			"unavailable",
			"all"
		];
		const DECISION_KINDS = {
			work: "accept,reopen",
			stop: "stop",
			ignore: "ignore",
			unavailable: "unavailable",
			all: ""
		};
		/** Build a typed route caller that resolves localized error messages on each request. */
		function caller(messages) {
			return (route, ...[request]) => {
				const [method, pattern] = route.split(" ");
				const values = request ?? {};
				const path = pattern.replace(/:(\w+)/g, (_match, name) => encodeURIComponent(String(values[name])));
				const query = Object.entries(values.query ?? {}).filter(([, value]) => value !== void 0 && value !== "").map(([name, value]) => `${name}=${encodeURIComponent(String(value))}`).join("&");
				return api(messages(), query ? `${path}?${query}` : path, method, values.body);
			};
		}
		//#endregion
		//#region src/client/client.css?raw
		var client_default = "/* Panel layout and local UI controls styled with DSH `--dsw-alias-*` design tokens; one rule per line. */\r\n/* VsSaros change: the page and the side panel with the Overview sit side by side (the side panel's look follows DSH's right sidebar). */\r\n.dt-shell { box-sizing: border-box; height: 100%; display: flex; position: relative; overflow: hidden; container-type: inline-size; container-name: dt-shell; }\r\n.dt-shell > .dt-page { flex: 1 1 auto; min-width: 0; }\r\n.dt-page { box-sizing: border-box; height: 100%; overflow: auto; scrollbar-gutter: stable; scroll-padding: 48px 0 72px; container-type: inline-size; padding: 28px clamp(24px, 4vw, 48px) 0; color: var(--dsw-alias-label-primary); }\r\n/* Deployment page rendered inside DSH Plugin Manager, which owns scrolling and padding. */\r\n.dt-embedded { container-type: inline-size; color: var(--dsw-alias-label-primary); }\r\n/* Disable sticky positioning inside DSH Plugin Manager, where the host container owns scrolling and bottom padding. */\r\n.dt-embedded .dt-savebar { position: static; }\r\n.dt-page > .dt-column { max-width: 960px; margin: 0 auto; padding-bottom: 48px; display: flex; flex-direction: column; gap: 24px; }\r\n.dt-head { position: relative; z-index: 3; display: flex; align-items: flex-start; justify-content: space-between; gap: 8px 16px; flex-wrap: wrap; }\r\n.dt-search { position: relative; width: 240px; max-width: 100%; }\r\n.dt-search-results { position: absolute; top: calc(100% + 6px); right: 0; width: min(560px, 90cqw); max-height: 60vh; overflow: auto; padding: 8px 16px; border: 0.5px solid var(--dsw-alias-border-l3); border-radius: 12px; background: var(--dsw-alias-bg-layer-2); box-shadow: var(--dsw-elevation-prominent); z-index: 5; display: flex; flex-direction: column; gap: 8px; }\r\n.dt-mark { background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 25%, transparent); color: inherit; border-radius: 2px; }\r\n[data-platform='darwin'] .dt-page .dt-head { padding-top: var(--dsh-frame-top-clearance, 0px); }\r\n.dt-title { margin: 0; font-size: 15px; line-height: 22px; font-weight: 600; color: var(--dsw-alias-label-secondary); }\r\n.dt-toolbar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }\r\n.dt-page .dt-tabs { display: flex; flex-wrap: wrap; gap: 4px 20px; overflow: visible; max-width: none; padding: 0 0 6px; border-radius: 0; background: none; border-bottom: 0.5px solid var(--dsw-alias-border-l3); }\r\n.dt-segmented { width: 100%; max-width: 420px; box-sizing: border-box; display: inline-grid; height: auto; align-items: stretch; gap: 2px; padding: 3px; border-radius: 9px; background: var(--dsw-alias-interactive-bg-hover); }\r\n.dt-form.dt-block { padding: 16px; border: 0.5px solid var(--dsw-alias-border-l3); border-radius: 16px; gap: 16px; }\r\n.dt-block-title { display: flex; align-items: center; gap: 4px; margin: 0; font-size: 16px; line-height: 24px; font-weight: 500; }\r\n.dt-section { display: flex; flex-direction: column; gap: 8px; min-width: 0; }\r\n.dt-section-title { margin: 0; display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px; font-size: 13px; line-height: 20px; font-weight: 600; color: var(--dsw-alias-label-secondary); }\r\n.dt-section-name { white-space: nowrap; }\r\n.dt-count { font-size: 14px; color: var(--dsw-alias-label-caption); font-variant-numeric: tabular-nums; font-weight: 400; }\r\n.dt-hint { margin: 0; font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-tertiary); }\r\n.dt-error { margin: 0; font-size: 13px; line-height: 20px; color: var(--dsw-alias-state-error-primary); }\r\n.dt-banner { margin: 0; padding: 8px 12px; border-radius: 10px; font-size: 13px; line-height: 20px; background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 10%, transparent); overflow-wrap: anywhere; }\r\n.dt-banner.dt-danger { background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent); }\r\n.dt-list { list-style: none; margin: 0 -8px; padding: 0; display: flex; flex-direction: column; gap: 2px; }\r\n.dt-row { position: relative; min-width: 0; border-radius: 12px; padding: 10px 8px; display: flex; flex-wrap: wrap; gap: 4px 12px; align-items: flex-start; }\r\n.dt-row.dt-link:hover { background: var(--dsw-alias-interactive-bg-hover); }\r\n.dt-row-main { flex: 1 1 200px; min-width: 0; display: flex; flex-direction: column; gap: 4px; }\r\n.dt-disclosure-body .dt-row-main { flex-basis: 0; }\r\n.dt-row-title { display: flex; align-items: center; gap: 8px; min-width: 0; font-size: 14px; line-height: 20px; font-weight: 500; }\r\n.dt-open { max-width: 100%; padding: 0; border: 0; background: transparent; color: inherit; font: inherit; font-size: 14px; line-height: 20px; font-weight: 500; text-align: left; cursor: pointer; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }\r\n.dt-open::after { content: ''; position: absolute; inset: 0; border-radius: 12px; }\r\n.dt-open:focus-visible { outline: none; }\r\n.dt-open-wrap { white-space: normal; }\r\n.dt-open:focus-visible::after { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }\r\n.dt-row-meta { display: flex; align-items: center; flex-wrap: wrap; gap: 4px 10px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-caption); overflow-wrap: anywhere; }\r\n.dt-row-quote { font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }\r\n.dt-clamp { display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }\r\n/* Transparent block borders preserve vertical spacing when line clamping clips padding. */\r\n.dt-banner:is(.dt-clamp, .dt-clamp-8) { padding-block: 0; border-block: 8px solid transparent; }\r\n.dt-banner-label { font-weight: 500; }\r\n.dt-banner .dt-md { display: inline; }\r\n.dt-banner .dt-md > p:first-child { display: inline; }\r\n.dt-row-buttons { position: relative; z-index: 1; gap: 8px; margin-top: 4px; }\r\n.dt-row-actions { position: relative; z-index: 1; display: flex; align-items: center; gap: 4px; flex: none; margin-left: auto; font-size: 13px; line-height: 20px; }\r\n.dt-dot { flex: none; margin-top: 5px; }\r\n.dt-inline-link { position: relative; z-index: 1; color: var(--dsw-alias-link); text-decoration: none; }\r\n.dt-inline-link:hover { text-decoration: underline; }\r\n.dt-textlink { padding: 0; border: 0; background: none; font: inherit; color: var(--dsw-alias-link); cursor: pointer; text-align: left; }\r\n.dt-textlink:hover { text-decoration: underline; }\r\n.dt-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 13px; line-height: 20px; }\r\n.dt-kv { display: grid; grid-template-columns: max-content 1fr; gap: 6px 16px; margin: 0; font-size: 13px; line-height: 20px; }\r\n.dt-kv dt { color: var(--dsw-alias-label-tertiary); }\r\n.dt-kv dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }\r\n.dt-timeline { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }\r\n.dt-event { padding: 12px 0; border-bottom: 0.5px solid var(--dsw-alias-border-l2); display: flex; flex-direction: column; gap: 6px; min-width: 0; }\r\n.dt-event:last-child { border-bottom: 0; }\r\n.dt-event.dt-highlight { background: var(--dsw-alias-interactive-bg-hover); border-radius: 8px; padding-inline: 8px; margin-inline: -8px; }\r\n.dt-event-text { margin: 0; font-size: 13px; line-height: 20px; white-space: pre-wrap; overflow-wrap: anywhere; }\r\n.dt-event-actor { font-weight: 500; color: var(--dsw-alias-label-secondary); }\r\n.dt-event-quiet .dt-event-text { color: var(--dsw-alias-label-tertiary); }\r\n.dt-flow { margin: 0; font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-secondary); }\r\n.dt-clamp-8 { display: -webkit-box; -webkit-line-clamp: 8; -webkit-box-orient: vertical; overflow: hidden; }\r\n.dt-more { align-self: flex-start; font-size: 12px; }\r\n.dt-reveal { opacity: 0; }\r\n.dt-event:hover .dt-reveal, .dt-reveal:focus-visible { opacity: 1; }\r\n@media (hover: none) {\r\n  .dt-reveal { opacity: 1; }\r\n}\r\n.dt-event-foot { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }\r\n.dt-filters { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }\r\n.dt-filters .dt-search { margin-left: auto; }\r\n.dt-form { display: flex; flex-direction: column; gap: 24px; }\r\n.dt-fieldset { display: flex; flex-direction: column; gap: inherit; min-width: 0; margin: 0; padding: 0; border: 0; }\r\n.dt-field { display: flex; flex-direction: column; gap: 6px; font-size: 13px; line-height: 20px; min-width: 0; }\r\n.dt-field small { color: var(--dsw-alias-label-caption); font-size: 12px; }\r\n.dt-textarea { box-sizing: border-box; width: 100%; min-width: 0; border: 0.5px solid var(--dsw-alias-border-l3); border-radius: 10px; padding: 8px 12px; font: inherit; font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-1, transparent); resize: vertical; }\r\n.dt-select { box-sizing: border-box; width: 100%; min-width: 0; height: 32px; border: 0.5px solid var(--dsw-alias-border-l4); border-radius: 8px; padding: 0 28px 0 8px; text-overflow: ellipsis; font: inherit; font-size: 14px; line-height: 22px; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-1, transparent); }\r\n.dt-textarea:focus-visible, .dt-select:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }\r\n.dt-mono { font-family: var(--ds-font-family-code, Menlo, monospace); font-size: 12px; overflow-wrap: anywhere; }\r\n.dt-detail { margin-top: 2px; color: var(--dsw-alias-label-secondary); }\r\n.dt-savebar .dt-error { white-space: pre-line; }\r\n.dt-switch-row { display: flex; align-items: center; justify-content: space-between; gap: 16px; min-height: 36px; font-size: 13px; }\r\n.dt-subhead-actions { display: inline-flex; align-items: center; gap: 4px; }\r\n.dt-btn-busy .dt-btn-icon svg { animation: dt-spin 1s linear infinite; }\r\n.dt-subhead { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-secondary); }\r\n.dt-rules, .dt-changes { list-style: none; margin: 0; padding: 0; }\r\n.dt-field-head { display: inline-flex; align-items: center; gap: 4px; color: var(--dsw-alias-label-secondary); }\r\n.dt-info { display: inline-flex; align-items: center; justify-content: center; width: 16px; height: 16px; padding: 0; border: 0; background: none; color: var(--dsw-alias-label-caption); cursor: help; }\r\n.dt-info:hover, .dt-info:focus-visible { color: var(--dsw-alias-label-secondary); }\r\n.dt-info:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; border-radius: 50%; }\r\n.dt-tooltip { position: fixed; z-index: 1100; width: max-content; max-width: min(320px, calc(100vw - 24px)); padding: 3px 7px; border-radius: 8px; background: var(--dsw-alias-tooltip-bg); color: var(--dsw-static-neutral-bluish-00); font-size: 13px; line-height: 20px; overflow-wrap: break-word; pointer-events: none; animation: dt-tooltip-in 150ms ease-in-out; }\r\n@keyframes dt-tooltip-in { from { opacity: 0; } }\r\n.dt-rules { border-top: 0.5px solid var(--dsw-alias-border-l2); }\r\n.dt-rule { display: flex; align-items: flex-start; gap: 12px; padding: 6px 0; border-bottom: 0.5px solid var(--dsw-alias-border-l2); }\r\n.dt-rule > :first-child { flex: 1; min-width: 0; }\r\n.dt-rule-preview { flex: 1; min-width: 0; margin-left: 8px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; color: var(--dsw-alias-label-caption); }\r\n.dt-rule-switch { margin-top: 2px; flex: none; }\r\n.dt-rule-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: var(--dsw-alias-label-caption); }\r\n.dt-rule-dot[data-enabled] { background: var(--dsw-alias-brand-primary); }\r\n.dt-rule-body { display: flex; flex-direction: column; gap: 12px; padding: 8px 0 8px 28px; }\r\n.dt-model { display: flex; flex-direction: column; gap: 6px; }\r\n.dt-grid3 { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }\r\n.dt-changes { display: flex; flex-direction: column; gap: 2px; font-size: 13px; line-height: 20px; }\r\n.dt-changes li::before { content: '· '; color: var(--dsw-alias-label-caption); }\r\n.dt-main { display: flex; flex-direction: column; gap: 24px; min-width: 0; }\r\n.dt-modal.dt-glossary-modal { width: min(680px, 100%); }\r\n.dt-nav-item { display: flex; align-items: center; justify-content: space-between; gap: 8px; width: 100%; min-height: 32px; padding: 6px 10px; border: 0; border-radius: 8px; background: transparent; color: var(--dsw-alias-label-secondary); font: inherit; font-size: 13px; line-height: 20px; text-align: left; cursor: pointer; }\r\n.dt-nav-item:hover { background: var(--dsw-alias-interactive-bg-hover); }\r\n.dt-nav-item[aria-current='true'] { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); font-weight: 500; }\r\n.dt-nav-item:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: -2px; }\r\n.dt-changed-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--dsw-alias-brand-primary); flex: none; }\r\n.dt-add-skill { display: flex; flex-direction: column; gap: 6px; margin-top: 8px; padding-top: 8px; border-top: 0.5px solid var(--dsw-alias-border-l2); }\r\n.dt-prompt-main { display: flex; flex-direction: column; gap: 12px; min-width: 0; }\r\n.dt-editor { min-height: 360px; }\r\n.dt-inline-select { width: auto; }\r\n.dt-preview-part { display: flex; flex-direction: column; gap: 6px; padding: 2px 0 2px 12px; border-left: 2px solid var(--dsw-alias-border-l3); }\r\n.dt-preview-head { font-size: 13px; line-height: 20px; display: flex; align-items: baseline; gap: 8px; }\r\ndiv.dt-preview-head { color: var(--dsw-alias-label-secondary); }\r\n.dt-card { display: flex; flex-direction: column; gap: 12px; padding: 16px; border: 0.5px solid var(--dsw-alias-border-l3); border-radius: 16px; min-width: 0; }\r\n.dt-card-head { display: flex; align-items: center; gap: 12px; min-height: 28px; }\r\n.dt-card-head .dt-row-main { flex: 1 1 0; min-width: 64px; }\r\n.dt-card-title { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }\r\n.dt-row-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; font-weight: 500; }\r\n.dt-rows { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 10px; }\r\n.dt-rows-item { display: flex; flex-direction: column; min-width: 0; gap: 10px; padding: 10px 12px; border: 0.5px solid var(--dsw-alias-border-l3); border-radius: 12px; background: var(--dsw-alias-bg-layer-2); }\r\n.dt-rows-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-width: 0; }\r\n.dt-rows-title { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; line-height: 20px; font-weight: 600; color: var(--dsw-alias-label-primary); }\r\n.dt-rows-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(132px, 1fr)); gap: 8px 12px; min-width: 0; }\r\n.dt-rows-cell { display: flex; flex-direction: column; min-width: 0; gap: 4px; }\r\n.dt-rows-cell-label { font-size: 12px; line-height: 16px; color: var(--dsw-alias-label-tertiary); }\r\n.dt-rows-cell .dt-row-label { white-space: normal; overflow-wrap: anywhere; }\r\n.dt-filter-gap { flex: 1; }\r\n.dt-page-head { display: flex; flex-direction: column; align-items: flex-start; gap: 4px; }\r\n.dt-page-head > .dt-btn { margin-left: -10px; }\r\n.dt-page-title { display: flex; align-items: center; gap: 8px 16px; flex-wrap: wrap; width: 100%; }\r\n.dt-page-title h2 { margin: 0; flex: 1 1 auto; min-width: 0; font-size: 20px; line-height: 28px; font-weight: 500; overflow-wrap: anywhere; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }\r\n.dt-status-line { margin-top: -16px; }\r\n.dt-plain-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; font-size: 13px; line-height: 20px; }\r\n.dt-details { display: flex; flex-direction: column; gap: 2px; border-top: 0.5px solid var(--dsw-alias-border-l2); padding-top: 8px; }\r\n.dt-danger-zone { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; padding-top: 16px; border-top: 0.5px solid var(--dsw-alias-border-l2); }\r\n.dt-danger-zone .dt-btn { color: var(--dsw-alias-state-error-primary); }\r\n.dt-md { display: flex; flex-direction: column; gap: 6px; font-size: 13px; line-height: 20px; overflow-wrap: anywhere; }\r\n.dt-md p, .dt-md ul, .dt-md ol { margin: 0; }\r\n.dt-md ul, .dt-md ol { padding-left: 20px; display: flex; flex-direction: column; gap: 2px; }\r\n.dt-md-heading { font-weight: 500; }\r\n.dt-code { font-family: var(--ds-font-family-code, Menlo, monospace); font-size: 12px; padding: 0 4px; border-radius: 4px; background: var(--dsw-alias-bg-module-platform); }\r\n.dt-dot-wrap { display: inline-flex; flex: none; }\r\n.dt-search-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }\r\n.dt-ellipsis { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 280px; }\r\n.dt-legend-title { margin: 16px 0 6px; font-size: 13px; color: var(--dsw-alias-label-tertiary); }\r\n.dt-legend { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: 6px 16px; font-size: 13px; }\r\n.dt-legend li { display: flex; align-items: center; gap: 6px; }\r\n.dt-legend .dt-dot { margin-top: 0; }\r\n.dt-savebar { position: sticky; bottom: 0; z-index: 2; display: flex; align-items: center; justify-content: flex-end; gap: 8px; flex-wrap: wrap; padding: 12px 0; background: var(--dsw-alias-bg-base, var(--dsw-alias-bg-layer-1)); border-top: 0.5px solid var(--dsw-alias-border-l2); }\r\n.dt-savebar .dt-hint { margin-right: auto; }\r\n.dt-card > .dt-savebar, .dt-block > .dt-savebar { margin: 0 -16px -16px; padding: 12px 16px; border-radius: 0 0 16px 16px; }\r\n.dt-glossary { width: 100%; border-collapse: collapse; font-size: 13px; line-height: 20px; }\r\n.dt-glossary th, .dt-glossary td { text-align: left; padding: 6px 8px; border-bottom: 0.5px solid var(--dsw-alias-border-l2); vertical-align: top; }\r\n.dt-glossary th { color: var(--dsw-alias-label-tertiary); font-weight: 400; }\r\n.dt-glossary th.dt-glossary-group { color: var(--dsw-alias-label-secondary); font-weight: 600; padding-top: 14px; }\r\n.dt-glossary th:nth-child(-n+2), .dt-glossary td:nth-child(-n+2) { white-space: nowrap; }\r\n.dt-values { display: grid; grid-template-columns: max-content 1fr; gap: 6px 16px; margin: 16px 0 0; font-size: 13px; }\r\n.dt-values dt { color: var(--dsw-alias-label-tertiary); }\r\n.dt-values dd { margin: 0; }\r\n.dt-pre { margin: 0; padding: 12px; border-radius: 10px; background: var(--dsw-alias-bg-module-platform); font-family: var(--ds-font-family-code, Menlo, monospace); font-size: 12px; line-height: 18px; white-space: pre-wrap; overflow-wrap: anywhere; max-height: 480px; overflow: auto; }\r\n.dt-pre ins { background: color-mix(in srgb, var(--dsw-alias-state-success-primary, green) 18%, transparent); text-decoration: none; }\r\n.dt-pre del { background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 18%, transparent); text-decoration: none; }\r\n.dt-prompt { display: grid; grid-template-columns: 200px minmax(0, 1fr); gap: 20px; align-items: start; }\r\n.dt-prompt-nav { display: flex; flex-direction: column; gap: 2px; }\r\n.dt-prompt-nav button { justify-content: flex-start; }\r\n.dt-disclosure-body { padding: 8px 0 8px 28px; display: flex; flex-direction: column; gap: 8px; }\r\n@container (max-width: 640px) {\r\n  .dt-tab { padding: 0 8px; font-size: 13px; }\r\n  .dt-segment { padding: 4px 10px; }\r\n  .dt-head { align-items: center; }\r\n  .dt-search-results { right: auto; left: 0; width: 100%; }\r\n  .dt-page-title h2 { font-size: 17px; line-height: 24px; }\r\n  .dt-status-line { margin-top: -12px; }\r\n  .dt-page .dt-tabs { display: flex; flex-wrap: wrap; gap: 4px 10px; overflow: visible; scrollbar-width: auto; mask-image: none; }\r\n  .dt-page .dt-tabs .dt-tab { flex: none; height: 32px; padding: 0 6px; font-size: 13px; }\r\n  .dt-kv { grid-template-columns: 1fr; gap: 2px; }\r\n  .dt-grid3, .dt-prompt { grid-template-columns: 1fr; }\r\n  .dt-search { width: 100%; }\r\n  .dt-filters .dt-search { margin-left: 0; }\r\n}\r\n/* Local UI primitive styles (see controls.tsx). */\r\n.dt-btn { display: inline-flex; align-items: center; justify-content: center; gap: 4px; border: none; border-radius: 18px; cursor: pointer; font: inherit; font-size: 14px; line-height: 22px; color: var(--dsw-alias-label-primary); background: transparent; padding: 0 14px; white-space: nowrap; }\r\n.dt-btn:disabled { cursor: not-allowed; opacity: 0.4; }\r\n.dt-btn:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }\r\n.dt-btn-md { height: 36px; }\r\n.dt-btn-sm { height: 28px; font-size: 12px; line-height: 18px; padding: 0 10px; border-radius: 14px; }\r\n.dt-btn-primary { background: var(--dsw-alias-button-primary-fill); color: var(--dsw-alias-label-primary-foreground); }\r\n.dt-btn-primary:hover:not(:disabled) { background: var(--dsw-alias-button-primary-hover); }\r\n.dt-btn-ghost:hover:not(:disabled), .dt-btn-outline:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }\r\n.dt-btn-ghost:active:not(:disabled) { background: var(--dsw-alias-interactive-bg-active); }\r\n.dt-btn-outline { border: 0.5px solid var(--dsw-alias-border-l3); }\r\n.dt-btn-icon { display: inline-flex; width: 16px; height: 16px; align-items: center; justify-content: center; }\r\n.dt-tag { display: inline-flex; align-items: center; border-radius: 999px; padding: 1px 8px; font-size: 11px; line-height: 17px; font-weight: 500; white-space: nowrap; }\r\n.dt-tag[data-tone='outline'] { border: 0.5px solid var(--dsw-alias-border-l4); color: var(--dsw-alias-label-tertiary); }\r\n.dt-tag[data-tone='neutral'] { background: var(--dsw-alias-bg-module-platform); color: var(--dsw-alias-label-secondary); }\r\n.dt-tag[data-tone='quiet'] { color: var(--dsw-alias-label-tertiary); }\r\n.dt-tag[data-tone='success'] { background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 10%, transparent); color: var(--dsw-alias-state-success-primary); }\r\n.dt-tag[data-tone='info'] { background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 10%, transparent); color: var(--dsw-alias-state-business-primary); }\r\n.dt-tag[data-tone='warning'] { background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 12%, transparent); color: var(--dsw-alias-state-warn-primary); }\r\n.dt-tag[data-tone='danger'] { background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent); color: var(--dsw-alias-state-error-primary); }\r\n.dt-pill { display: inline-flex; align-items: center; gap: 4px; height: 24px; padding: 0 8px; border: none; border-radius: 12px; font: inherit; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-layer-2); cursor: pointer; }\r\n.dt-pill:hover { background: var(--dsw-alias-interactive-bg-hover); }\r\n.dt-pill-active, .dt-pill-active:hover { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-button-ghost-active-fill); box-shadow: inset 0 0 0 1px var(--dsw-alias-button-ghost-active-border); }\r\n.dt-tabs { display: grid; padding: 4px; border-radius: 12px; background: var(--dsw-alias-bg-module-platform); }\r\n.dt-tab { box-sizing: border-box; height: 34px; padding: 0 12px; border: 0.5px solid transparent; border-radius: 8px; background: transparent; color: var(--dsw-alias-label-secondary); font: inherit; font-size: 14px; line-height: 20px; white-space: nowrap; cursor: pointer; transition: color 180ms ease, background 180ms ease; }\r\n.dt-tab:hover { color: var(--dsw-alias-label-primary); }\r\n.dt-tab[aria-selected='true'] { color: var(--dsw-alias-label-primary); font-weight: 600; background: var(--dsw-alias-bg-layer-3); border-color: var(--dsw-alias-border-l3); }\r\n.dt-tab:focus-visible { outline: none; text-decoration: underline; text-underline-offset: 4px; }\r\n.dt-segment { height: auto; min-height: 28px; display: flex; align-items: center; justify-content: center; text-align: center; white-space: normal; overflow-wrap: anywhere; padding: 4px 10px; border: 0; border-radius: 7px; background: transparent; color: var(--dsw-alias-label-secondary); font: inherit; font-size: 13px; line-height: 20px; font-weight: 500; cursor: pointer; transition: color 120ms ease, background 160ms ease; }\r\n.dt-segment:hover:not(:disabled), .dt-segment[aria-selected='true'] { color: var(--dsw-alias-label-primary); }\r\n.dt-segment[aria-selected='true'] { background: var(--dsw-alias-bg-layer-1); box-shadow: var(--dsw-elevation-soft); }\r\n.dt-segment:disabled { cursor: default; opacity: 0.4; }\r\n.dt-segment:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: -2px; }\r\n.dt-input { box-sizing: border-box; display: inline-flex; align-items: center; gap: 6px; height: 32px; min-width: 0; padding: 0 8px; border: 0.5px solid var(--dsw-alias-border-l4); border-radius: 8px; background: var(--dsw-alias-bg-layer-1); }\r\n.dt-input:focus-within { border-color: var(--dsw-alias-brand-primary); }\r\n.dt-input-icon { display: inline-flex; width: 16px; height: 16px; align-items: center; justify-content: center; color: var(--dsw-alias-label-tertiary); }\r\n.dt-input input { flex: 1; min-width: 0; border: none; outline: none; background: transparent; font: inherit; font-size: 14px; line-height: 22px; color: var(--dsw-alias-label-primary); }\r\n.dt-input input::placeholder { color: var(--dsw-alias-label-dimmed); }\r\n.dt-input input::-webkit-search-cancel-button { -webkit-appearance: none; appearance: none; }\r\n.dt-field .dt-input, .dt-search .dt-input, .dt-add-skill .dt-input { display: flex; width: 100%; }\r\n.dt-cli-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }\r\n.dt-field .dt-cli-row .dt-input { flex: 1 1 auto; width: auto; }\r\n.dt-cli-actions { display: inline-flex; flex: 0 0 auto; align-items: center; gap: 4px; }\r\n.dt-switch { box-sizing: border-box; flex: 0 0 auto; width: 36px; height: 20px; padding: 2px; border: 0; border-radius: 10px; background: var(--dsw-alias-border-l3); cursor: pointer; }\r\n.dt-switch[aria-checked='true'] { background: var(--dsw-alias-brand-primary); }\r\n.dt-switch:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }\r\n.dt-switch-thumb { display: block; width: 16px; height: 16px; border-radius: 50%; background: var(--dsw-alias-label-primary-foreground); transition: transform 120ms ease; }\r\n.dt-switch[aria-checked='true'] .dt-switch-thumb { transform: translateX(16px); }\r\n.dt-state-dot { position: relative; display: inline-block; flex: none; width: 10px; height: 10px; color: var(--dsw-alias-state-idle-primary); }\r\n.dt-state-dot::after { content: ''; position: absolute; inset: 20%; border-radius: 50%; background: currentColor; }\r\n.dt-state-dot[data-state='done'] { color: var(--dsw-alias-state-success-primary); }\r\n.dt-state-dot[data-state='warning'] { color: var(--dsw-alias-state-warn-primary); }\r\n.dt-state-dot[data-state='error'] { color: var(--dsw-alias-state-error-primary); }\r\n.dt-spinner { flex: none; color: var(--dsw-alias-label-tertiary); }\r\n.dt-spinner g { transform-origin: center; animation: dt-spin 1.5s linear infinite; }\r\n.dt-spinner circle { fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; }\r\n.dt-spinner circle:first-child { opacity: 0.25; }\r\n.dt-spinner circle:last-child { stroke-dasharray: 18 150; }\r\n@keyframes dt-spin { to { transform: rotate(360deg); } }\r\n.dt-disclosure-row { display: flex; align-items: center; gap: 4px; min-height: 28px; min-width: 0; border-radius: 8px; cursor: pointer; font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-secondary); }\r\n.dt-disclosure-row:hover { color: var(--dsw-alias-label-primary); }\r\n.dt-disclosure-row:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }\r\n.dt-disclosure-lead { position: relative; display: inline-flex; flex: none; width: 24px; height: 24px; align-items: center; justify-content: center; }\r\n.dt-disclosure-icon { display: inline-flex; align-items: center; justify-content: center; }\r\n.dt-disclosure-chevron { position: absolute; inset: 0; display: none; align-items: center; justify-content: center; }\r\n.dt-disclosure-row:hover .dt-disclosure-icon, .dt-disclosure[data-open] .dt-disclosure-icon { visibility: hidden; }\r\n.dt-disclosure-row:hover .dt-disclosure-chevron, .dt-disclosure[data-open] .dt-disclosure-chevron { display: inline-flex; }\r\n.dt-disclosure-title { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }\r\n.dt-modal-root { position: fixed; inset: 0; z-index: 1000; display: flex; align-items: center; justify-content: center; padding: max(24px, var(--dsh-frame-top-clearance, 24px)) 24px; }\r\n.dt-modal-mask { position: absolute; inset: 0; background: var(--dsw-alias-bg-mask-1); backdrop-filter: var(--dsw-mask-blur); }\r\n.dt-modal { position: relative; z-index: 1; display: flex; flex-direction: column; gap: 20px; width: min(380px, 100%); max-height: 100%; padding: 0 0 24px; overflow: hidden; border-radius: 24px; background: var(--dsw-alias-bg-layer-2); box-shadow: var(--dsw-elevation-prominent); color: var(--dsw-alias-label-primary); outline: none; }\r\n.dt-modal-header { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 22px 14px 0 24px; }\r\n.dt-modal-header h2 { margin: 0; font-size: 16px; line-height: 24px; font-weight: 500; }\r\n.dt-modal-close { display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; border: none; border-radius: 8px; background: transparent; cursor: pointer; color: var(--dsw-alias-label-secondary); }\r\n.dt-modal-close:hover { background: var(--dsw-alias-interactive-bg-hover); }\r\n.dt-modal-description { margin: -8px 0 0; padding: 0 24px; font-size: 14px; line-height: 22px; }\r\n.dt-modal-body { min-width: 0; min-height: 0; overflow: auto; padding: 0 24px; }\r\n.dt-modal-footer { display: flex; align-items: center; justify-content: flex-end; gap: 8px; padding: 0 24px; }\r\n.dt-toast { position: fixed; top: 40px; left: 50%; z-index: 1100; pointer-events: none; width: max-content; max-width: min(640px, calc(100vw - 48px)); padding: 12px 16px; border-radius: 14px; background: var(--dsw-alias-toast-bg); color: var(--dsw-static-neutral-bluish-00); font-size: 14px; line-height: 22px; box-shadow: var(--dsw-shadow-lv3); transform: translateX(-50%); animation: dt-toast-in 160ms ease-out, dt-toast-fade 1000ms ease var(--dt-toast-hold, 3000ms) forwards; }\r\n@keyframes dt-toast-in { from { opacity: 0; transform: translate(-50%, -6px); } to { opacity: 1; transform: translate(-50%, 0); } }\r\n@keyframes dt-toast-fade { to { opacity: 0; visibility: hidden; } }\r\n@media (prefers-reduced-motion: reduce) {\r\n  .dt-tab, .dt-segment, .dt-switch-thumb, .dt-spinner g, .dt-btn-busy .dt-btn-icon svg, .dt-tooltip { transition: none; animation: none; }\r\n  .dt-toast { animation: dt-toast-fade 1000ms ease var(--dt-toast-hold, 3000ms) forwards; }\r\n}\r\n.dt-page .dt-tab { height: 34px; padding: 0 2px; border: 0; border-radius: 0; color: var(--dsw-alias-label-tertiary); font-size: 14px; }\r\n.dt-page .dt-tab[aria-selected='true'] { background: none; color: var(--dsw-alias-label-primary); font-weight: 500; box-shadow: inset 0 -1.5px 0 var(--dsw-alias-label-primary); }\r\n.dt-status-head { display: flex; align-items: center; gap: 8px; }\r\n.dt-status-title { margin: 0; flex: 1; display: flex; align-items: center; gap: 4px; font-size: 15px; line-height: 22px; font-weight: 600; }\r\n.dt-status-text { margin-left: auto; flex: none; font-size: 12px; font-weight: 400; color: var(--dsw-alias-label-secondary); }\r\n.dt-status-line .dt-status-text { margin-left: 0; }\r\n.dt-status-text[data-state='warning'] { color: var(--dsw-alias-state-warn-primary); }\r\n.dt-status-text[data-state='error'] { color: var(--dsw-alias-state-error-primary); }\r\n.dt-row-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; }\r\n.dt-lv { white-space: nowrap; }\r\n.dt-lv-label { color: var(--dsw-alias-label-caption); }\r\n.dt-lv-value { color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; }\r\n.dt-chip { display: inline-flex; flex-wrap: wrap; max-width: 100%; border: 0.5px solid var(--dsw-alias-border-l3); border-radius: 6px; overflow: hidden; font-size: 11px; line-height: 18px; color: var(--dsw-alias-label-secondary); }\r\n.dt-chip-source { padding: 0 6px; color: var(--dsw-alias-label-tertiary); background: var(--dsw-alias-bg-module-platform); }\r\n.dt-chip-fact { padding: 0 6px; border-left: 0.5px solid var(--dsw-alias-border-l3); white-space: nowrap; }\r\n.dt-chip-label { margin-right: 4px; color: var(--dsw-alias-label-caption); }\r\n.dt-chip-link { position: relative; z-index: 1; text-decoration: none; cursor: pointer; transition: border-color 120ms ease; }\r\n.dt-chip-link:hover { border-color: var(--dsw-alias-brand-primary); }\r\n.dt-chip-link:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }\r\n.dt-chip-open { display: inline-flex; align-items: center; padding: 0 5px; border-left: 0.5px solid var(--dsw-alias-border-l3); color: var(--dsw-alias-brand-primary); }\r\n.dt-chip-problem, .dt-chip-problem .dt-chip-label { color: var(--dsw-alias-state-error-primary); }\r\n.dt-cards { gap: 8px; }\r\n.dt-att .dt-inline-link { font-size: 13px; font-weight: 500; }\r\n.dt-list > .dt-att { margin: 2px 8px; }\r\n.dt-att { padding: 10px 12px 10px 16px; border: 0; border-radius: 0; border-bottom: 0.5px solid var(--dsw-alias-border-l3); }\r\n.dt-att::before { content: ''; position: absolute; left: 6px; top: 10px; bottom: 10px; width: 2px; border-radius: 1px; background: var(--dsw-alias-state-warn-primary); opacity: 0.7; }\r\n.dt-att-error::before { background: var(--dsw-alias-state-error-primary); }\r\n.dt-att-what { font-size: 12px; line-height: 18px; font-weight: 500; color: var(--dsw-alias-state-warn-primary); }\r\n.dt-att-error .dt-att-what, .dt-att-error .dt-att-what .dt-open { color: var(--dsw-alias-state-error-primary); }\r\n.dt-stats { display: flex; flex-wrap: wrap; gap: 6px 20px; }\r\n.dt-stat { display: inline-flex; align-items: baseline; gap: 6px; font-size: 12px; color: var(--dsw-alias-label-caption); }\r\n.dt-stat-value { font-size: 14px; font-weight: 500; color: var(--dsw-alias-label-primary); font-variant-numeric: tabular-nums; }\r\n.dt-more-link { font-size: 12px; font-weight: 400; }\r\n.dt-settings { display: grid; grid-template-columns: 140px minmax(0, 1fr); gap: 24px; align-items: start; }\r\n.dt-settings-nav { position: sticky; top: 0; display: flex; flex-direction: column; gap: 2px; }\r\n.dt-settings-link { padding: 6px 10px; border: 0; border-radius: 8px; background: none; color: var(--dsw-alias-label-secondary); font: inherit; font-size: 14px; text-align: left; cursor: pointer; }\r\n.dt-settings-link:hover { color: var(--dsw-alias-label-primary); }\r\n.dt-settings-link[aria-current='page'] { background: var(--dsw-alias-bg-module-platform); color: var(--dsw-alias-label-primary); font-weight: 500; }\r\n.dt-settings-link[data-stage] + .dt-settings-link:not([data-stage]) { margin-top: 10px; }\r\n.dt-settings-body { display: flex; flex-direction: column; gap: 16px; min-width: 0; }\r\n.dt-settings-title { margin: 0; font-size: 15px; line-height: 22px; font-weight: 600; }\r\n.dt-subtabs { display: flex; gap: 16px; border-bottom: 0.5px solid var(--dsw-alias-border-l3); }\r\n.dt-subtab { padding: 0 0 6px; border: 0; background: none; color: var(--dsw-alias-label-tertiary); font: inherit; font-size: 13px; cursor: pointer; }\r\n.dt-subtab[aria-selected='true'] { color: var(--dsw-alias-label-primary); font-weight: 500; box-shadow: inset 0 -1.5px 0 var(--dsw-alias-label-primary); }\r\n.dt-part { display: flex; flex-direction: column; gap: 12px; }\r\n.dt-rows-summary { text-align: left; color: var(--dsw-alias-label-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%; }\r\n.dt-table { width: 100%; border-collapse: collapse; font-size: 12px; line-height: 18px; }\r\n.dt-table th { text-align: left; font-weight: 400; color: var(--dsw-alias-label-caption); padding: 2px 8px 2px 0; }\r\n.dt-table td { padding: 4px 8px 4px 0; border-top: 0.5px solid var(--dsw-alias-border-l3); vertical-align: top; color: var(--dsw-alias-label-secondary); overflow-wrap: anywhere; }\r\n@container (max-width: 640px) {\r\n  .dt-settings { grid-template-columns: 1fr; gap: 12px; }\r\n  .dt-settings-nav { position: static; flex-direction: row; flex-wrap: wrap; }\r\n  .dt-settings-link[data-stage] + .dt-settings-link:not([data-stage]) { margin-top: 0; }\r\n  .dt-page .dt-tabs { gap: 14px; }\r\n}\r\n.dt-list > .dt-ticket { display: grid; grid-template-columns: 112px minmax(0, 1fr); column-gap: 12px; align-items: start; margin: 0; padding: 12px 8px 12px 18px; border-radius: 0; border-bottom: 0.5px solid var(--dsw-alias-border-l3); }\r\n.dt-list > .dt-ticket[data-state]::before { content: ''; position: absolute; left: 6px; top: 12px; bottom: 12px; width: 2px; border-radius: 1px; background: var(--dsw-alias-state-warn-primary); opacity: 0.7; }\r\n.dt-list > .dt-ticket[data-state='error']::before { background: var(--dsw-alias-state-error-primary); }\r\n.dt-ticket-stage { align-self: stretch; padding-top: 1px; border-right: 0.5px solid var(--dsw-alias-border-l3); }\r\n.dt-ticket-body { display: flex; flex-direction: column; gap: 4px; min-width: 0; }\r\n.dt-ticket-body .dt-row-title .dt-open { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }\r\n.dt-ticket-meta { flex-wrap: nowrap; overflow: hidden; white-space: nowrap; }\r\n.dt-ticket-meta .dt-chip { flex: none; }\r\n.dt-ticket-note { min-width: 0; overflow: hidden; text-overflow: ellipsis; color: var(--dsw-alias-label-primary); }\r\n.dt-ticket-note-error { color: var(--dsw-alias-state-error-primary); }\r\n.dt-ticket-actions { position: relative; z-index: 1; display: flex; flex-wrap: wrap; gap: 8px; min-height: 30px; margin-top: 2px; }\r\n/* Pass pointer events through action containers to the row link, keeping only child controls interactive. */\r\n.dt-ticket-actions, .dt-row-buttons, .dt-row-actions { pointer-events: none; }\r\n.dt-ticket-actions > *, .dt-row-buttons > *, .dt-row-actions > * { pointer-events: auto; }\r\n.dt-line { min-height: 20px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }\r\n.dt-row-meta.dt-line { flex-wrap: nowrap; }\r\n.dt-line-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }\r\n.dt-error-text { color: var(--dsw-alias-state-error-primary); }\r\n.dt-stage { display: inline-flex; align-items: flex-start; gap: 5px; font-size: 12px; line-height: 18px; font-weight: 500; color: var(--dsw-alias-label-secondary); }\r\n.dt-stage svg { flex: none; margin-top: 2px; }\r\n.dt-stage[data-state='warning'] { color: var(--dsw-alias-state-warn-primary); }\r\n.dt-stage[data-state='error'] { color: var(--dsw-alias-state-error-primary); }\r\n.dt-stage[data-state='ongoing'] { color: var(--dsw-alias-state-business-primary); }\r\n.dt-icon-link { display: inline-flex; align-items: center; gap: 4px; }\r\na.dt-btn, a.dt-btn:hover { text-decoration: none; }\r\n.dt-section-icon { display: inline-flex; align-self: center; color: var(--dsw-alias-label-tertiary); }\r\n.dt-trigger-link { display: flex; flex-direction: column; gap: 2px; width: 100%; margin: -4px 0 -4px -8px; padding: 4px 8px; border: 0; border-radius: 8px; background: none; font: inherit; color: inherit; text-align: left; cursor: pointer; }\r\n.dt-trigger-link:hover { background: var(--dsw-alias-interactive-bg-hover); }\r\n.dt-trigger-link:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }\r\n.dt-trigger-text { display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }\r\n.dt-kv-stack { display: flex; flex-direction: column; gap: 2px; min-width: 0; }\r\n.dt-banner-actions { margin-top: 6px; }\r\n@container (max-width: 640px) {\r\n  .dt-list > .dt-ticket { grid-template-columns: 1fr; row-gap: 4px; }\r\n  .dt-ticket-stage { border-right: 0; }\r\n}\r\n.dt-nav-group { margin: 10px 10px 2px; font-size: 12px; font-weight: 600; color: var(--dsw-alias-label-secondary); }\r\n.dt-nav-group:first-child { margin-top: 0; }\r\n.dt-prompt-nav .dt-nav-item { flex-direction: column; align-items: flex-start; gap: 2px; text-align: left; }\r\n.dt-nav-item > span { display: inline-flex; align-items: center; gap: 6px; }\r\n.dt-nav-item small { font-size: 12px; line-height: 18px; font-weight: 400; color: var(--dsw-alias-label-caption); }\r\n.dt-preview-part[data-editable] { border-left-color: var(--dsw-alias-brand-primary); }\r\n.dt-preview-head b { font-weight: 500; }\r\n.dt-preview-head > span { font-size: 12px; color: var(--dsw-alias-label-caption); }\r\n.dt-changed-tag { margin-left: 6px; padding: 0 5px; border: 0.5px solid var(--dsw-alias-border-l3); border-radius: 4px; font-size: 11px; line-height: 16px; font-weight: 400; color: var(--dsw-alias-label-secondary); }\r\n.dt-updated-tag { border-color: var(--dsw-alias-state-warn-primary); color: var(--dsw-alias-state-warn-primary); }\r\n.dt-default-updated { display: flex; flex-direction: column; gap: 6px; padding: 2px 0 2px 12px; border-left: 2px solid var(--dsw-alias-state-warn-primary); }\r\n.dt-diff-fold { color: var(--dsw-alias-label-caption); font-style: italic; }\r\n.dt-compare { margin-left: auto; }\r\n.dt-admission th { white-space: nowrap; }\r\n.dt-admission thead tr:first-child th:not(:first-child) { color: var(--dsw-alias-label-secondary); font-weight: 500; }\r\n.dt-admission td { vertical-align: middle; }\r\n.dt-admission-scope { color: var(--dsw-alias-label-primary); font-size: 13px; }\r\n.dt-admission-scope small { display: block; font-size: 11px; color: var(--dsw-alias-label-caption); }\r\n.dt-admission-na { color: var(--dsw-alias-label-caption); }\r\n.dt-admission-cell { display: flex; align-items: center; gap: 4px; }\r\n.dt-admission-cell .dt-select { flex: 1; min-width: 0; }\r\n.dt-admission-slot { display: inline-flex; flex: none; width: 16px; }\r\n.dt-info-warn { color: var(--dsw-alias-state-warn-primary); }\r\n.dt-field-segmented { max-width: 240px; }\r\n/* VsSaros addition: changelist reviews. */\r\n.dt-review-desc { margin: 0; white-space: pre-wrap; font-family: var(--ds-font-family-code, Menlo, monospace); font-size: 12px; }\r\n.dt-review-files { display: flex; flex-direction: column; gap: 4px; margin: 8px 0; }\r\n.dt-review-ack { display: flex; align-items: center; gap: 8px; margin: 8px 0; font-size: 13px; }\r\n.dt-diff { margin: 0; max-height: 480px; overflow: auto; padding: 8px; border-radius: 8px; background: var(--dsw-alias-bg-module-platform); font-family: var(--ds-font-family-code, Menlo, monospace); font-size: 12px; line-height: 18px; }\r\n.dt-diff-add { color: var(--dsw-alias-state-success-primary, #2da44e); }\r\n.dt-diff-del { color: var(--dsw-alias-state-error-primary, #cf222e); }\r\n.dt-diff-hunk { color: var(--dsw-alias-label-caption); }\r\n/* VsSaros addition: the panel as a whole-page workbench in the middle column. */\r\n.dt-workbench { box-sizing: border-box; height: 100%; min-height: 0; display: flex; flex-direction: column; }\r\n.dt-workbench > .dt-page { flex: 1 1 auto; min-height: 0; }\r\n.dt-workbench > .dt-shell { flex: 1 1 auto; min-height: 0; height: auto; }\r\n/* VsSaros addition: the side panel with the Overview, resized from its left edge. */\r\n.dt-side { box-sizing: border-box; position: relative; flex: none; width: var(--dt-side-width, 400px); height: 100%; display: flex; flex-direction: column; background: var(--dsw-alias-bg-base); border-left: 0.5px solid var(--dsw-alias-border-l4); color: var(--dsw-alias-label-primary); }\r\n.dt-side-grip { position: absolute; top: 0; bottom: 0; left: -4px; width: 8px; z-index: 2; cursor: col-resize; touch-action: none; }\r\n.dt-side-grip::after { content: ''; position: absolute; top: 0; bottom: 0; left: 3.5px; width: 1px; opacity: 0; background: linear-gradient(transparent, var(--dsw-alias-label-caption), transparent); transition: opacity 160ms ease; }\r\n.dt-side-grip:hover::after, .dt-side-grip:focus-visible::after, .dt-side[data-dragging] .dt-side-grip::after { opacity: 1; }\r\n.dt-side-grip:focus-visible { outline: none; }\r\n.dt-side-strip { flex: none; display: flex; align-items: center; gap: 4px; padding: 10px 6px 0 10px; }\r\n.dt-side-tab { height: 28px; min-width: 80px; max-width: 170px; box-sizing: border-box; padding: 0 10px; border-radius: 8px; display: inline-flex; align-items: center; font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-markdown-tag, var(--dsw-alias-bg-module-platform)); }\r\n.dt-side-tools { margin-left: auto; display: flex; align-items: center; gap: 4px; }\r\n.dt-side-body { flex: 1 1 auto; min-height: 0; overflow: auto; padding: 16px 18px 40px; display: flex; flex-direction: column; gap: 20px; }\r\n.dt-side-body .dt-row-actions { margin-left: 0; }\r\n/* Below this width the page keeps its room and the side panel floats over it. */\r\n@container dt-shell (max-width: 900px) {\r\n  .dt-side { position: absolute; top: 0; right: 0; bottom: 0; z-index: 6; max-width: calc(100% - 48px); border-left: 0; border-radius: 16px 0 0 16px; box-shadow: var(--dsw-elevation-prominent); }\r\n}\r\n/* VsSaros addition: the Chat tab, the supervisor desk; bubbles and composer follow DSH's chat. */\r\n.dt-chat { flex: 1 1 auto; display: flex; flex-direction: column; }\r\n/* The Chat tab fills the page's height, so its composer sits at the bottom also while the conversation is short. */\r\n.dt-page:has(.dt-chat) > .dt-column { box-sizing: border-box; min-height: 100%; padding-bottom: 0; }\r\n.dt-page:has(.dt-chat) .dt-main { flex: 1 1 auto; }\r\n.dt-chat-log { flex: 1 1 auto; display: flex; flex-direction: column; gap: 6px; padding: 4px 0 16px; }\r\n.dt-msg { display: flex; min-width: 0; }\r\n.dt-msg-person { flex-direction: column; align-items: flex-end; gap: 4px; margin: 6px 0; }\r\n.dt-msg-bubble { max-width: min(620px, 82%); box-sizing: border-box; padding: 10px 16px; border-radius: 20px; background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 10%, transparent); font-size: 14px; line-height: 22px; white-space: pre-wrap; overflow-wrap: anywhere; }\r\n.dt-msg-meta { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 4px 10px; padding: 0 6px; font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-caption); }\r\n.dt-msg-filtered { color: var(--dsw-alias-state-warn-primary); }\r\n/* ★ 2026-11-05: optimistic user bubbles / submissions still on their way, after DS Bot's chat flow. */\r\n.dt-msg-local { opacity: 0.88; }\r\n.dt-msg-local[data-placement='queued'] .dt-msg-bubble { border: 1px dashed var(--dsw-alias-border-l2); }\r\n.dt-msg-local[data-state='failed'] .dt-msg-bubble { border: 1px solid var(--dsw-alias-state-error-primary); }\r\n.dt-msg-placement { color: var(--dsw-alias-label-tertiary); }\r\n.dt-chat-activity { align-self: center; display: flex; flex-wrap: wrap; justify-content: center; gap: 8px; margin: 2px 0; font-size: 11px; color: var(--dsw-alias-label-tertiary); }\r\n.dt-composer-note[data-testid='composer-queue-note'] { pointer-events: none; }\r\n.dt-msg-agent { gap: 12px; align-items: flex-start; margin: 12px 0; }\r\n.dt-msg-avatar { flex: none; width: 28px; height: 28px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; font-size: 11px; font-weight: 600; color: #fff; background: linear-gradient(135deg, #4176e6, #7c5cf0); }\r\n.dt-msg-main { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 2px; }\r\n.dt-msg-who { display: flex; align-items: center; flex-wrap: wrap; gap: 4px 8px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }\r\n.dt-msg-text { font-size: 14px; line-height: 24px; white-space: pre-wrap; overflow-wrap: anywhere; }\r\n.dt-msg-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; margin-top: 8px; }\r\n/* The composer follows DeepSeek-Bot's: one rounded row of \"+\", the draft, the microphone and the voice (or send) button. */\r\n.dt-composer-dock { position: sticky; bottom: 0; z-index: 2; padding: 8px 0 20px; background: linear-gradient(transparent, var(--dsw-alias-bg-base) 36px); }\r\n.dt-composer { position: relative; box-sizing: border-box; display: flex; flex-wrap: wrap; align-items: flex-end; min-height: 44px; padding: 7.5px; border-radius: 22px; background: var(--dsw-alias-bg-layer-2); border: 0.5px solid var(--dsw-alias-border-l3); box-shadow: 0 4px 16px rgba(0, 0, 0, 0.03), 0 0 24px rgba(0, 0, 0, 0.03); transition: border-color 150ms ease, border-radius 200ms ease; }\r\n.dt-composer:hover, .dt-composer:focus-within { border-color: color-mix(in srgb, var(--dsw-alias-label-primary) 30%, transparent); }\r\n.dt-composer[data-tall] { border-radius: 18px; }\r\n.dt-composer-input { order: 2; flex: 1 1 0; box-sizing: border-box; min-width: 0; min-height: 28px; max-height: 200px; resize: none; field-sizing: content; border: 0; outline: none; background: transparent; color: var(--dsw-alias-label-primary); font: inherit; font-size: 14px; line-height: 24px; padding: 2px 8px; caret-color: var(--dsw-alias-state-business-primary); }\r\n.dt-composer-input::placeholder { color: color-mix(in srgb, var(--dsw-alias-label-primary) 36%, transparent); }\r\n.dt-composer-plus, .dt-composer-mic, .dt-composer-voice, .dt-composer-send { flex: none; width: 28px; height: 28px; padding: 0; border: 0; border-radius: 50%; display: inline-grid; place-items: center; cursor: pointer; transition: background-color 150ms ease, color 150ms ease, scale 150ms ease; }\r\n.dt-composer-plus { order: 1; background: color-mix(in srgb, var(--dsw-alias-label-primary) 5%, transparent); box-shadow: inset 0 0 0 0.5px var(--dsw-alias-border-l3); color: var(--dsw-alias-label-secondary); }\r\n.dt-composer-plus:hover, .dt-composer-plus[aria-expanded='true'], .dt-composer-mic:hover { background: color-mix(in srgb, var(--dsw-alias-label-primary) 10%, transparent); color: var(--dsw-alias-label-primary); }\r\n.dt-composer-plus svg { transition: rotate 200ms cubic-bezier(0.34, 1.56, 0.64, 1); }\r\n.dt-composer-plus[aria-expanded='true'] svg { rotate: 45deg; }\r\n.dt-composer-plus:active, .dt-composer-mic:active, .dt-composer-voice:active, .dt-composer-send:active:not(:disabled) { scale: 0.9; }\r\n.dt-composer-trailing { order: 3; flex: none; display: flex; align-items: center; gap: 8px; }\r\n.dt-composer-mic { background: color-mix(in srgb, var(--dsw-alias-label-primary) 5%, transparent); box-shadow: inset 0 0 0 0.5px var(--dsw-alias-border-l3); color: var(--dsw-alias-label-secondary); }\r\n.dt-composer-mic[aria-pressed='true'] { background: #ff3e51; color: #fff; animation: dt-mic-pulse 1.4s ease-in-out infinite; }\r\n@keyframes dt-mic-pulse { 0%, 100% { box-shadow: 0 0 0 0 rgba(255, 62, 81, 0.4) } 50% { box-shadow: 0 0 0 6px rgba(255, 62, 81, 0) } }\r\n.dt-composer-voice, .dt-composer-send { background: var(--dsw-alias-state-business-primary); color: #fff; animation: dt-icon-swap 220ms cubic-bezier(0.34, 1.56, 0.64, 1); }\r\n@keyframes dt-icon-swap { from { opacity: 0; transform: scale(0.5) rotate(-30deg) } }\r\n.dt-composer-voice:hover, .dt-composer-send:hover:not(:disabled) { opacity: 0.9; }\r\n.dt-composer-send:disabled { opacity: 0.4; cursor: not-allowed; }\r\n.dt-composer-plus:focus-visible, .dt-composer-mic:focus-visible, .dt-composer-voice:focus-visible, .dt-composer-send:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }\r\n.dt-composer-note { position: absolute; right: 12px; bottom: calc(100% + 8px); padding: 5px 10px; border-radius: 8px; background: var(--dsw-alias-tooltip-bg, #2c2c2e); color: #fff; font-size: 12px; line-height: 16px; white-space: nowrap; pointer-events: none; }\r\n.dt-composer-files { order: 0; flex: 0 0 100%; display: flex; flex-wrap: wrap; gap: 6px; padding: 2px 2px 8px; }\r\n.dt-composer-file { display: inline-flex; align-items: center; gap: 6px; max-width: 260px; height: 28px; padding: 0 4px 0 8px; border-radius: 8px; background: var(--dsw-alias-bg-module-platform); color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 18px; }\r\n.dt-composer-file-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--dsw-alias-label-primary); }\r\n.dt-composer-file-size { flex: none; color: var(--dsw-alias-label-caption); }\r\n.dt-composer-file button { flex: none; width: 20px; height: 20px; padding: 0; border: 0; border-radius: 6px; display: inline-grid; place-items: center; background: none; color: var(--dsw-alias-label-tertiary); cursor: pointer; }\r\n.dt-composer-file button:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }\r\n/* The \"+\" menu opens above it, as DeepSeek-Bot's does. */\r\n.dt-menu { position: absolute; left: 0; bottom: calc(100% + 8px); z-index: 4; box-sizing: border-box; min-width: 180px; max-width: min(360px, 100%); padding: 6px; border-radius: 12px; display: flex; flex-direction: column; gap: 2px; background: var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-base)); border: 0.5px solid var(--dsw-alias-border-l2); box-shadow: var(--dsw-elevation-prominent, 0 3px 8px rgba(0, 0, 0, 0.08)); transform-origin: bottom left; animation: dt-menu-lift 160ms cubic-bezier(0.34, 1.56, 0.64, 1); }\r\n@keyframes dt-menu-lift { from { opacity: 0; transform: translateY(4px) scale(0.96) } }\r\n.dt-menu button { display: flex; align-items: center; gap: 6px; width: 100%; min-height: 30px; box-sizing: border-box; padding: 6px 8px; border: 0; border-radius: 6px; background: none; text-align: left; font: inherit; font-size: 13px; line-height: 18px; color: var(--dsw-alias-label-primary); cursor: pointer; }\r\n.dt-menu button:hover { background: var(--dsw-alias-interactive-bg-hover); }\r\n.dt-menu button svg { flex: none; }\r\n.dt-menu-head { font-weight: 500; }\r\n.dt-menu-list { display: flex; flex-direction: column; gap: 2px; max-height: 260px; overflow: auto; }\r\n.dt-menu-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }\r\n.dt-menu-hint { flex: none; color: var(--dsw-alias-label-tertiary); font-size: 12px; }\r\n.dt-menu-note { margin: 0; padding: 6px 8px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }\r\n.dt-schedule { gap: 16px; }\r\n.dt-schedule-when { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; }\r\n/* Voice chat takes the conversation's place: an orb that breathes while it thinks and pulses while it speaks. */\r\n.dt-voice { flex: 1 1 auto; min-height: 420px; display: flex; flex-direction: column; align-items: center; justify-content: center; }\r\n.dt-voice-stage { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; padding: 24px; max-width: 560px; text-align: center; }\r\n.dt-voice-orb { position: relative; width: 200px; height: 200px; display: grid; place-items: center; margin-bottom: 8px; }\r\n.dt-voice-ring { position: absolute; inset: 34px; border-radius: 50%; background: var(--dsw-alias-interactive-bg-hover); }\r\n.dt-voice-stage[data-phase='listening'] .dt-voice-ring { animation: dt-voice-listen 1.8s ease-in-out infinite; }\r\n.dt-voice-stage[data-phase='thinking'] .dt-voice-ring { animation: dt-voice-breathe 1.6s ease-in-out infinite; }\r\n.dt-voice-stage[data-phase='speaking'] .dt-voice-ring { animation: dt-voice-speak 0.9s ease-in-out infinite; }\r\n@keyframes dt-voice-listen { 0%, 100% { transform: scale(1) } 50% { transform: scale(1.04) } }\r\n@keyframes dt-voice-breathe { 0%, 100% { transform: scale(1) } 50% { transform: scale(1.08) } }\r\n@keyframes dt-voice-speak { 0%, 100% { transform: scale(1.04) } 30% { transform: scale(1.2) } 60% { transform: scale(1.1) } }\r\n.dt-voice-mark { position: relative; width: 88px; height: 88px; border-radius: 50%; display: grid; place-items: center; color: #fff; background: linear-gradient(135deg, #4176e6, #7c5cf0); }\r\n.dt-voice-name { font-size: 16px; line-height: 22px; font-weight: 500; }\r\n.dt-voice-status { min-height: 18px; font-size: 13px; line-height: 18px; color: var(--dsw-alias-label-secondary); }\r\n.dt-voice-caption { min-height: 44px; font-size: 15px; line-height: 22px; display: -webkit-box; -webkit-line-clamp: 4; -webkit-box-orient: vertical; overflow: hidden; }\r\n.dt-voice-note { font-size: 12px; color: var(--dsw-alias-state-error-primary); }\r\n.dt-voice-bar { display: flex; gap: 16px; padding: 0 0 32px; }\r\n.dt-voice-btn { width: 52px; height: 52px; border-radius: 50%; border: 0; display: grid; place-items: center; background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); cursor: pointer; transition: background-color 150ms ease, transform 120ms ease; }\r\n.dt-voice-btn:hover { background: var(--dsw-alias-interactive-bg-active); }\r\n.dt-voice-btn:active { transform: scale(0.94); }\r\n.dt-voice-end { background: #ff3e51; color: #fff; }\r\n.dt-voice-end:hover { background: #e02135; }\r\n@media (prefers-reduced-motion: reduce) {\r\n  .dt-menu, .dt-voice-ring, .dt-composer-mic, .dt-composer-voice, .dt-composer-send { animation: none !important; }\r\n}\r\n/* VsSaros addition: the Chat tab in a VsSaros workbench is DSH's own chat of the desk, docked by the host; it fills the page. */\r\n.dt-page:has(.dt-native-chat) > .dt-column { height: 100%; min-height: 0; }\r\n.dt-page:has(.dt-native-chat) .dt-main { min-height: 0; }\r\n.dt-native-chat { min-height: 0; position: relative; }\r\n.dt-chat-dock { flex: none; max-height: 40%; overflow: auto; margin: 0 0 8px; padding: 10px 12px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 10px; background: var(--dsw-alias-bg-module-platform); display: flex; flex-direction: column; gap: 8px; }\r\n.dt-chat-dock-title { margin: 0; font-size: 12px; font-weight: 600; color: var(--dsw-alias-state-warn-primary); }\r\n.dt-chat-dock .dt-list { margin: 0; }\r\n.dt-native-chat .vssWbNewSession, .dt-native-chat .vssWbConversation { display: none; }\r\n.dt-native-chat [data-slot=\"conversation.input.permission\"], .dt-native-chat [data-slot=\"conversation.input.model\"], .dt-native-chat [data-slot=\"conversation.input.plan\"] { display: none; }\r\n.dt-native-wait { margin: 24px 0; font-size: 13px; color: var(--dsw-alias-label-tertiary); }\r\n.dt-native-chat:has(.vssWbDock:not([hidden])) .dt-native-wait { display: none; }\r\n/* VsSaros addition (plan C): what waits for the person, the teams' members, and the Workbench tab. States share one colour each. */\r\n:is(.dt-flow-node, .dt-flow-edge, .dt-mini-node, .dt-board-card, .dt-flow-line)[data-state='pending'] { --dt-state: var(--dsw-alias-label-caption); }\r\n:is(.dt-flow-node, .dt-flow-edge, .dt-mini-node, .dt-board-card, .dt-flow-line)[data-state='running'] { --dt-state: var(--dsw-alias-state-business-primary); }\r\n:is(.dt-flow-node, .dt-flow-edge, .dt-mini-node, .dt-board-card, .dt-flow-line)[data-state='ready'] { --dt-state: var(--dsw-alias-state-success-primary); }\r\n:is(.dt-flow-node, .dt-flow-edge, .dt-mini-node, .dt-board-card, .dt-flow-line):is([data-state='blocked'], [data-state='alert']) { --dt-state: var(--dsw-alias-state-warn-primary); }\r\n:is(.dt-flow-node, .dt-flow-edge, .dt-mini-node, .dt-board-card, .dt-flow-line)[data-state='failed'] { --dt-state: var(--dsw-alias-state-error-primary); }\r\n:is(.dt-flow-node, .dt-flow-edge, .dt-mini-node, .dt-board-card, .dt-flow-line):is([data-state='skipped'], [data-state='stopped']) { --dt-state: var(--dsw-alias-label-tertiary); }\r\n.dt-shimmer { background: linear-gradient(90deg, color-mix(in srgb, var(--dsw-alias-label-secondary) 45%, transparent), var(--dsw-alias-label-primary), color-mix(in srgb, var(--dsw-alias-label-secondary) 45%, transparent)); background-size: 200% 100%; -webkit-background-clip: text; background-clip: text; color: transparent; animation: dt-shimmer 2.2s steps(60) infinite; }\r\n@keyframes dt-shimmer { from { background-position: 200% 0 } to { background-position: -200% 0 } }\r\n.dt-elapsed { font-variant-numeric: tabular-nums; }\r\n.dt-approvals { display: flex; flex-direction: column; gap: 8px; }\r\n.dt-approval { display: flex; flex-direction: column; gap: 6px; padding: 10px 12px; border-radius: 12px; background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 8%, transparent); box-shadow: inset 0 0 0 0.5px color-mix(in srgb, var(--dsw-alias-state-warn-primary) 40%, transparent); font-size: 12.5px; line-height: 18px; animation: dt-rise 0.42s cubic-bezier(0.34, 1.32, 0.64, 1) both; }\r\n@keyframes dt-rise { from { opacity: 0; transform: translateY(8px) scale(0.98) } }\r\n.dt-approval-head { display: flex; align-items: center; flex-wrap: wrap; gap: 6px 8px; font-size: 13px; }\r\n.dt-approval-ticket { color: var(--dsw-alias-label-tertiary); font-size: 12px; }\r\n.dt-approval-code { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: 11.5px/16px ui-monospace, SFMono-Regular, Consolas, monospace; color: var(--dsw-alias-label-secondary); }\r\n.dt-approval-why { color: var(--dsw-alias-label-secondary); overflow-wrap: anywhere; }\r\n.dt-approval .dt-row-actions { margin-left: 0; flex-wrap: wrap; }\r\n.dt-team-run .dt-row-main { gap: 8px; }\r\n.dt-mini-flow { display: block; max-width: 100%; overflow-x: auto; padding: 6px; border: 0; border-radius: 10px; background: var(--dsw-alias-bg-module-platform); cursor: pointer; text-align: left; }\r\n.dt-mini-flow:hover { box-shadow: inset 0 0 0 0.5px var(--dsw-alias-border-l3); }\r\n.dt-mini-flow:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }\r\n.dt-mini-node rect { fill: color-mix(in srgb, var(--dt-state) 14%, var(--dsw-alias-bg-base)); stroke: var(--dt-state); stroke-width: 1; }\r\n.dt-mini-node text { font-size: 11px; fill: var(--dsw-alias-label-primary); }\r\n.dt-flow-line { fill: none; stroke: var(--dt-state, var(--dsw-alias-label-caption)); stroke-width: 1.5; opacity: 0.6; }\r\n.dt-members { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }\r\n.dt-member { display: flex; align-items: center; gap: 10px; min-height: 44px; padding: 4px 2px; }\r\n.dt-member-main { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; }\r\n.dt-member-name { display: flex; align-items: center; flex-wrap: wrap; gap: 4px 6px; font-size: 13px; line-height: 20px; }\r\n.dt-member-step { color: var(--dsw-alias-label-tertiary); font-size: 12px; }\r\n.dt-member-line { font-size: 12px; line-height: 17px; color: var(--dsw-alias-label-tertiary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }\r\n.dt-member-alert { color: var(--dsw-alias-state-warn-primary); }\r\n.dt-work { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; gap: 10px; padding-bottom: 20px; }\r\n.dt-work-teams { display: flex; flex-wrap: wrap; gap: 6px; }\r\n.dt-work-team { height: 28px; padding: 0 12px; border: 0; border-radius: 14px; font: inherit; font-size: 12.5px; color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-module-platform); cursor: pointer; }\r\n.dt-work-team[aria-pressed='true'] { color: var(--dsw-alias-label-primary); box-shadow: inset 0 0 0 1px var(--dsw-alias-label-primary); }\r\n.dt-work-bar { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 10px; font-size: 13px; }\r\n.dt-work-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--dsw-alias-label-caption); }\r\n.dt-work-dot[data-live] { background: var(--dsw-alias-state-success-primary); animation: dt-pulse 1.6s ease-in-out infinite; }\r\n@keyframes dt-pulse { 50% { opacity: 0.45; transform: scale(0.8) } }\r\n.dt-work-views { margin-left: auto; }\r\n.dt-work-body { position: relative; flex: 1 1 auto; min-height: 360px; display: flex; flex-direction: column; }\r\n.dt-graph { position: relative; flex: 1 1 auto; min-height: 360px; overflow: hidden; border-radius: 12px; background-color: var(--dsw-alias-bg-module-platform); background-image: radial-gradient(color-mix(in srgb, var(--dsw-alias-label-primary) 12%, transparent) 1px, transparent 1px); background-size: 24px 24px; cursor: grab; touch-action: none; }\r\n.dt-flow-zoom { position: absolute; z-index: 2; top: 10px; right: 10px; display: flex; align-items: center; gap: 2px; padding: 2px; border-radius: 8px; background: color-mix(in srgb, var(--dsw-alias-bg-base) 82%, transparent); backdrop-filter: blur(8px); box-shadow: 0 0 0 0.5px var(--dsw-alias-border-l3); font-size: 12px; color: var(--dsw-alias-label-secondary); }\r\n.dt-flow-zoom button { width: 26px; height: 24px; border: 0; border-radius: 6px; background: none; color: var(--dsw-alias-label-primary); font: inherit; cursor: pointer; }\r\n.dt-flow-zoom button:hover { background: var(--dsw-alias-interactive-bg-hover); }\r\n.dt-flow-zoom span { min-width: 38px; text-align: center; font-variant-numeric: tabular-nums; }\r\n.dt-flow-canvas { position: absolute; left: 0; top: 0; transform-origin: 0 0; }\r\n.dt-flow-lines { position: absolute; left: 0; top: 0; overflow: visible; pointer-events: none; }\r\n.dt-flow-edge .dt-flow-line { stroke-width: 2.5; opacity: 0.5; }\r\n.dt-flow-glow { fill: none; stroke: var(--dt-state); stroke-width: 7; opacity: 0.12; }\r\n.dt-flow-moving { fill: none; stroke: var(--dt-state); stroke-width: 2; stroke-dasharray: 5 9; animation: dt-flow-move 0.75s linear infinite; }\r\n@keyframes dt-flow-move { to { stroke-dashoffset: -28 } }\r\n.dt-flow-node { position: absolute; box-sizing: border-box; display: flex; flex-direction: column; gap: 4px; padding: 9px 12px 9px 15px; overflow: hidden; border: 0; border-radius: 12px; text-align: left; font: inherit; color: var(--dsw-alias-label-primary); background: linear-gradient(135deg, color-mix(in srgb, var(--dt-state) 9%, var(--dsw-alias-bg-base)), var(--dsw-alias-bg-base)); box-shadow: 0 0 0 0.5px var(--dsw-alias-border-l3); cursor: pointer; transition: box-shadow 0.2s ease; }\r\n.dt-flow-node::before { content: ''; position: absolute; left: 0; top: 0; bottom: 0; width: 3px; background: var(--dt-state); }\r\n.dt-flow-node:is([data-state='running'], [data-state='alert'], [data-state='blocked']) { box-shadow: 0 0 0 1px color-mix(in srgb, var(--dt-state) 34%, transparent), 0 6px 18px color-mix(in srgb, var(--dt-state) 16%, transparent); }\r\n.dt-flow-node[data-state='pending'] { opacity: 0.62; }\r\n.dt-flow-node[aria-pressed='true'] { box-shadow: 0 0 0 2px var(--dt-state); }\r\n.dt-flow-node:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }\r\n.dt-flow-node-title { display: flex; align-items: center; gap: 6px; font-size: 13px; line-height: 18px; font-weight: 500; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }\r\n.dt-flow-key { font: 600 11px/16px ui-monospace, SFMono-Regular, Consolas, monospace; color: var(--dsw-alias-label-tertiary); }\r\n.dt-flow-node-who { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--dsw-alias-label-secondary); }\r\n.dt-flow-node-meta { font-size: 11.5px; color: var(--dsw-alias-label-caption); }\r\n.dt-flow-retry { position: absolute; top: 8px; right: 10px; font-size: 11px; font-weight: 600; color: var(--dsw-alias-state-warn-primary); }\r\n.dt-flow-bar { position: absolute; left: 3px; right: 0; bottom: 0; height: 2px; overflow: hidden; background: color-mix(in srgb, var(--dt-state) 14%, transparent); }\r\n.dt-flow-bar i { display: block; width: 42%; height: 100%; background: var(--dt-state); animation: dt-flow-bar 1.1s linear infinite; }\r\n@keyframes dt-flow-bar { from { transform: translateX(-100%) } to { transform: translateX(350%) } }\r\n.dt-board { flex: 1 1 auto; display: flex; gap: 10px; overflow-x: auto; }\r\n.dt-board-col { flex: 1 1 0; min-width: 168px; display: flex; flex-direction: column; gap: 6px; padding: 6px; border: 1px dashed var(--dsw-alias-border-l3); border-radius: 10px; }\r\n.dt-board-col h3 { margin: 0; padding: 2px 4px; display: flex; justify-content: space-between; font-size: 12px; font-weight: 500; color: var(--dsw-alias-label-secondary); }\r\n.dt-board-card { position: relative; display: flex; flex-direction: column; gap: 2px; padding: 7px 9px 7px 12px; overflow: hidden; border: 0; border-radius: 8px; text-align: left; font: inherit; font-size: 12.5px; line-height: 18px; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-base); box-shadow: 0 0 0 0.5px var(--dsw-alias-border-l2); cursor: pointer; }\r\n.dt-board-card::before { content: ''; position: absolute; left: 0; top: 0; bottom: 0; width: 3px; background: var(--dt-state); }\r\n.dt-board-card b { font-weight: 500; }\r\n.dt-board-who { display: flex; align-items: center; gap: 4px; color: var(--dsw-alias-label-tertiary); font-size: 11.5px; }\r\n.dt-step-table { width: 100%; border-collapse: collapse; font-size: 13px; }\r\n.dt-step-table th { padding: 6px 8px; text-align: left; font-size: 12px; font-weight: 500; color: var(--dsw-alias-label-tertiary); border-bottom: 0.5px solid var(--dsw-alias-border-l3); }\r\n.dt-step-table td { padding: 8px; border-bottom: 0.5px solid var(--dsw-alias-border-l1); }\r\n.dt-step-table tbody tr { cursor: pointer; }\r\n.dt-step-table tbody tr:hover { background: var(--dsw-alias-interactive-bg-hover); }\r\n.dt-step-detail { position: absolute; z-index: 3; top: 12px; right: 12px; bottom: 12px; box-sizing: border-box; width: min(384px, calc(100% - 24px)); display: flex; flex-direction: column; gap: 10px; overflow: auto; padding: 14px 16px; border-radius: 14px; font-size: 13px; line-height: 20px; background: color-mix(in srgb, var(--dsw-alias-bg-base) 92%, transparent); backdrop-filter: blur(14px); box-shadow: var(--dsw-elevation-prominent, 0 14px 48px rgba(0, 0, 0, 0.18)); animation: dt-rise 0.28s cubic-bezier(0.2, 0, 0, 1) both; }\r\n.dt-step-detail-head { display: flex; align-items: center; gap: 8px; font-size: 14px; }\r\n.dt-step-detail-head .dt-btn { margin-left: auto; }\r\n.dt-step-facts { margin: 0; display: grid; grid-template-columns: 64px 1fr; gap: 3px 8px; font-size: 12.5px; }\r\n.dt-step-facts dt { color: var(--dsw-alias-label-tertiary); }\r\n.dt-step-facts dd { margin: 0; }\r\n.dt-step-attempts { display: flex; flex-direction: column; gap: 4px; font-size: 12.5px; }\r\n.dt-step-report { margin: 0; white-space: pre-wrap; color: var(--dsw-alias-label-secondary); }\r\n@media (prefers-reduced-motion: reduce) {\r\n  .dt-shimmer, .dt-approval, .dt-work-dot, .dt-flow-moving, .dt-flow-bar i, .dt-step-detail { animation: none !important; }\r\n}\r\n\r\n/* VsSaros addition (plan C): a Bot's mark, after DS Bot's (mark.js and styles.js, Apache-2.0; see NOTICE). Its character moves for what it does. */\r\n.dt-bm { display: inline-block; flex: none; position: relative; line-height: 0; }\r\n.dt-bm svg { width: 100%; height: 100%; overflow: visible; }\r\n.dt-bm .dt-bm-b, .dt-bm .dt-bm-eye, .dt-bm .dt-bm-eyes { transform-box: fill-box; }\r\n.dt-bm .dt-bm-b { transform-origin: 50% 100%; }\r\n.dt-bm .dt-bm-eye, .dt-bm .dt-bm-eyes { transform-origin: center; }\r\n.dt-bm[data-faded] { filter: grayscale(1); opacity: 0.55; }\r\n.dt-bm[data-live]:is([data-state='idle'], [data-state='alert']) .dt-bm-eye { animation: dt-bm-blink-idle 5s linear infinite; animation-delay: var(--dt-bm-delay, 0s); }\r\n.dt-bm[data-live][data-state='idle']:is([data-fidget='hop'], [data-fidget='sway'], [data-fidget='stretch']) .dt-bm-b { animation: var(--dt-bm-fidget) 9s ease-in-out var(--dt-bm-fidget-delay, 0s) infinite; }\r\n.dt-bm[data-live][data-state='idle'][data-fidget='hop'] { --dt-bm-fidget: dt-bm-fidget-hop; }\r\n.dt-bm[data-live][data-state='idle'][data-fidget='sway'] { --dt-bm-fidget: dt-bm-fidget-sway; }\r\n.dt-bm[data-live][data-state='idle'][data-fidget='stretch'] { --dt-bm-fidget: dt-bm-fidget-stretch; }\r\n.dt-bm[data-live][data-state='idle'][data-fidget='look'] .dt-bm-eyes { animation: dt-bm-fidget-look 9s ease-in-out var(--dt-bm-fidget-delay, 0s) infinite; }\r\n.dt-bm[data-state='thinking'] .dt-bm-b { animation: dt-bm-ponder 2.2s ease-in-out infinite; }\r\n.dt-bm[data-state='thinking'] .dt-bm-eyes { animation: dt-bm-squint 2.2s ease-in-out infinite; }\r\n.dt-bm[data-state='searching'] .dt-bm-b { animation: dt-bm-seek 1s ease-in-out infinite; }\r\n.dt-bm[data-state='searching'] .dt-bm-eyes { animation: dt-bm-scan 1.6s ease-in-out infinite; }\r\n.dt-bm[data-state='working'] .dt-bm-b { animation: dt-bm-bob 1.6s ease-in-out infinite; }\r\n.dt-bm[data-state='working']:is([data-shape='star'], [data-shape='hex'], [data-shape='plus'], [data-shape='gem'], [data-shape='magnet'], [data-shape='ring']) .dt-bm-b { animation: dt-bm-wiggle 1.4s ease-in-out infinite; transform-origin: 50% 50%; }\r\n.dt-bm[data-state='working']:is([data-shape='gumdrop'], [data-shape='peanut'], [data-shape='cushion'], [data-shape='squircle'], [data-shape='moon'], [data-shape='wave']) .dt-bm-b { animation: dt-bm-squash 1.2s ease-in-out infinite; }\r\n.dt-bm[data-state='working'] .dt-bm-eye { animation: dt-bm-blink 2.4s ease-in-out infinite; }\r\n.dt-bm[data-state='sending'] .dt-bm-b { animation: dt-bm-dash 1.1s cubic-bezier(0.4, 0, 0.2, 1) infinite; }\r\n.dt-bm[data-state='waiting'] .dt-bm-b { animation: dt-bm-sway 2.6s ease-in-out infinite; transform-origin: 50% 50%; }\r\n.dt-bm[data-state='waiting'] .dt-bm-eyes { animation: dt-bm-roll 2.6s linear infinite; }\r\n.dt-bm[data-state='alert'] .dt-bm-b { animation: dt-bm-hop 1.3s cubic-bezier(0.3, 0.7, 0.4, 1) 2; }\r\n.dt-bm[data-live][data-state='alert'] .dt-bm-b { animation-iteration-count: infinite; }\r\n.dt-bm[data-state='done'] .dt-bm-b { animation: dt-bm-done 1.8s linear 1; }\r\n@keyframes dt-bm-fidget-hop { 0%, 8%, 100% { transform: none } 3% { transform: translateY(-10%) scale(0.97, 1.04) } 5.5% { transform: translateY(0) scale(1.05, 0.95) } }\r\n@keyframes dt-bm-fidget-sway { 0%, 10%, 100% { transform: none } 2.5% { transform: rotate(-8deg) } 5% { transform: rotate(7deg) } 7.5% { transform: rotate(-3deg) } }\r\n@keyframes dt-bm-fidget-stretch { 0%, 9%, 100% { transform: none } 4% { transform: scale(0.94, 1.08) } 7% { transform: scale(1.03, 0.97) } }\r\n@keyframes dt-bm-fidget-look { 0%, 22%, 100% { transform: none } 3%, 9% { transform: translateX(-14%) } 12%, 19% { transform: translateX(14%) } }\r\n@keyframes dt-bm-done { 0% { transform: none } 13.3% { transform: scale(1.12, 0.88) } 25.6% { transform: scale(0.93, 1.09) } 37.8% { transform: scale(1.04, 0.97) } 51.1%, 100% { transform: none } }\r\n@keyframes dt-bm-bob { 0%, 100% { transform: translateY(0) rotate(0) } 30% { transform: translateY(-4%) rotate(-5deg) } 65% { transform: translateY(0) rotate(4deg) } }\r\n@keyframes dt-bm-wiggle { 0%, 100% { transform: rotate(0) scale(1) } 25% { transform: rotate(-12deg) scale(1.04) } 75% { transform: rotate(12deg) scale(1.04) } }\r\n@keyframes dt-bm-squash { 0%, 100% { transform: scale(1, 1) } 30% { transform: scale(1.08, 0.9) } 55% { transform: translateY(-4%) scale(0.94, 1.08) } 80% { transform: scale(1.02, 0.98) } }\r\n@keyframes dt-bm-ponder { 0%, 100% { transform: translateY(0) rotate(4deg) } 50% { transform: translateY(-3%) rotate(7deg) } }\r\n@keyframes dt-bm-squint { 0%, 100% { transform: translate(0, -4%) scaleY(0.7) } 50% { transform: translate(5%, -5%) scaleY(0.78) } }\r\n@keyframes dt-bm-seek { 0%, 100% { transform: translateY(0) rotate(-4deg) } 50% { transform: translateY(-5%) rotate(-1deg) } }\r\n@keyframes dt-bm-scan { 0%, 100% { transform: translateX(-12%) } 50% { transform: translateX(12%) } }\r\n@keyframes dt-bm-dash { 0%, 100% { transform: translateX(0) rotate(0) } 35% { transform: translateX(9%) rotate(7deg) } 55% { transform: translateX(-2%) rotate(-3deg) } }\r\n@keyframes dt-bm-sway { 0%, 100% { transform: rotate(-10deg) } 50% { transform: rotate(10deg) } }\r\n@keyframes dt-bm-roll { 0%, 100% { transform: translate(12%, 0) } 25% { transform: translate(0, 9%) } 50% { transform: translate(-12%, 0) } 75% { transform: translate(0, -9%) } }\r\n@keyframes dt-bm-hop { 0%, 55%, 100% { transform: translateY(0) scale(1, 1) } 20% { transform: translateY(-14%) scale(0.96, 1.05) } 40% { transform: translateY(0) scale(1.06, 0.94) } }\r\n@keyframes dt-bm-blink-idle { 0%, 29.6%, 35%, 69.2%, 74.6%, 100% { transform: scaleY(1) } 32.2%, 71.8% { transform: scaleY(0.03) } 33.8%, 73.4% { transform: scaleY(1.06) } }\r\n@keyframes dt-bm-blink { 0%, 42%, 50%, 100% { transform: scaleY(1) } 46% { transform: scaleY(0.03) } 48% { transform: scaleY(1.06) } }\r\n.dt-bm-badge { position: absolute; right: 0; bottom: 0; box-sizing: border-box; display: flex; align-items: center; justify-content: center; border-radius: 50%; box-shadow: 0 0 0 1.5px var(--dsw-alias-bg-base); }\r\n.dt-bm-badge[data-kind='working'] { width: 8px; height: 8px; right: 1px; bottom: 1px; background: var(--dsw-alias-state-success-primary); }\r\n.dt-bm-badge[data-kind='alert'] { width: 12px; height: 12px; right: auto; bottom: auto; left: 50%; top: calc(var(--dt-bm-size, 28px) * -0.14); translate: -50% 0; background: var(--dsw-alias-state-warn-primary); color: #fff; font-size: 8.5px; line-height: 12px; font-weight: 600; animation: dt-bm-q-ride 1.3s cubic-bezier(0.3, 0.7, 0.4, 1) infinite; }\r\n@keyframes dt-bm-q-ride { 0%, 55%, 100% { transform: translateY(0) } 20% { transform: translateY(calc(var(--dt-bm-size, 28px) * -0.14)) } 40% { transform: translateY(0) } }\r\n/* VsSaros addition (plan C): a message's key-node card in the supervisor desk's DSH conversation. */\r\n.dt-fc { box-sizing: border-box; max-width: 640px; margin: 4px 0; padding: 12px 14px; border-radius: 14px; display: flex; flex-direction: column; gap: 10px; font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-base); box-shadow: 0 0 0 0.5px var(--dsw-alias-border-l3), 0 2px 8px rgba(0, 0, 0, 0.03); animation: dt-rise 0.32s cubic-bezier(0.2, 0, 0, 1) both; }\r\n.dt-fc[data-state='declined'] { color: var(--dsw-alias-label-secondary); }\r\n.dt-fc-line { flex-direction: row; align-items: center; gap: 8px; padding: 4px 0; margin: 0; background: none; box-shadow: none; color: var(--dsw-alias-label-tertiary); font-size: 12.5px; }\r\n.dt-fc-head { display: flex; align-items: center; gap: 10px; }\r\n.dt-fc-head-main { flex: 1; min-width: 0; display: flex; align-items: center; flex-wrap: wrap; gap: 4px 8px; }\r\n.dt-fc-head-main b { font-weight: 500; overflow-wrap: anywhere; }\r\n.dt-fc-nodes { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }\r\n.dt-fc-node { position: relative; display: flex; gap: 10px; padding: 0 0 12px; }\r\n.dt-fc-node:last-child { padding-bottom: 0; }\r\n.dt-fc-node::before { content: ''; position: absolute; left: 4.5px; top: 14px; bottom: 0; width: 1px; background: var(--dsw-alias-border-l3); }\r\n.dt-fc-node:last-child::before { display: none; }\r\n.dt-fc-dot { flex: none; position: relative; z-index: 1; width: 10px; height: 10px; margin-top: 5px; border-radius: 50%; box-sizing: border-box; border: 1.5px solid var(--dsw-alias-label-caption); background: var(--dsw-alias-bg-base); }\r\n.dt-fc-node[data-state='done'] .dt-fc-dot { border-color: var(--dsw-alias-state-success-primary); background: var(--dsw-alias-state-success-primary); }\r\n.dt-fc-node[data-state='active'] .dt-fc-dot { border-color: var(--dsw-alias-state-business-primary); box-shadow: 0 0 0 3px color-mix(in srgb, var(--dsw-alias-state-business-primary) 18%, transparent); animation: dt-pulse 1.6s ease-in-out infinite; }\r\n.dt-fc-node[data-state='fail'] .dt-fc-dot { border-color: var(--dsw-alias-state-error-primary); background: var(--dsw-alias-state-error-primary); }\r\n.dt-fc-node[data-state='wait'] .dt-fc-node-title { color: var(--dsw-alias-label-tertiary); }\r\n.dt-fc-node-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 8px; }\r\n.dt-fc-node-title { font-weight: 500; }\r\n.dt-fc-proposal { display: flex; flex-direction: column; gap: 6px; }\r\n.dt-fc-roles { display: flex; flex-wrap: wrap; gap: 6px; }\r\n.dt-fc-role { display: inline-flex; align-items: center; gap: 5px; height: 26px; padding: 0 9px 0 4px; border-radius: 13px; background: var(--dsw-alias-bg-module-platform); font-size: 12.5px; }\r\n.dt-fc-role em { font-style: normal; color: var(--dsw-alias-label-tertiary); }\r\n.dt-fc-note { margin: 0; font-size: 12.5px; line-height: 19px; color: var(--dsw-alias-label-secondary); overflow-wrap: anywhere; white-space: pre-wrap; }\r\n.dt-fc .dt-row-actions { margin-left: 0; }\r\n@media (prefers-reduced-motion: reduce) {\r\n  .dt-bm *, .dt-bm-badge, .dt-fc, .dt-fc-dot { animation: none !important; transition: none !important; }\r\n}\r\n/* ★ 2026-11-05: live group-chat runs in the Workbench / Execution tabs; independent of Ticket/Step selectors. */\r\n.dt-group-runs { box-sizing: border-box; margin: 0 0 12px; display: flex; flex-direction: column; gap: 8px; }\r\n.dt-group-runs-head { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--dsw-alias-label-secondary); }\r\n.dt-group-runs-head b { font-weight: 600; color: var(--dsw-alias-label-primary); }\r\n.dt-group-runs-list { display: flex; flex-direction: column; gap: 8px; }\r\n.dt-group-runs-card { box-sizing: border-box; padding: 8px 10px; display: flex; flex-direction: column; gap: 6px; border-radius: 9px; border: 1px solid var(--dsw-alias-border-l3); background: var(--dsw-alias-bg-base); }\r\n.dt-group-runs-card[data-state='done'] { border-color: var(--dsw-alias-state-success-primary); }\r\n.dt-group-runs-card[data-state='error'] { border-color: var(--dsw-alias-state-error-primary); }\r\n.dt-group-runs-card[data-state='cut'] { border-color: var(--dsw-alias-state-warn-primary); border-style: dashed; }\r\n.dt-group-runs-note { margin: 0; font-size: 11px; color: var(--dsw-alias-label-tertiary); }\r\n.dt-group-runs-open { margin-left: auto; flex: none; font-size: 11px; }\r\n.dt-group-runs-source { color: var(--dsw-alias-label-secondary); }\r\n.dt-group-runs-title { display: flex; align-items: center; gap: 6px; min-width: 0; font-size: 12px; }\r\n.dt-group-runs-title b { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }\r\n.dt-group-runs-status { color: var(--dsw-alias-label-tertiary); flex: none; }\r\n.dt-group-runs-dot { width: 7px; height: 7px; border-radius: 999px; flex: none; background: var(--dsw-alias-state-success-primary); }\r\n.dt-group-runs-dot[data-state='running'] { animation: dt-group-runs-live 1.6s ease-in-out infinite; }\r\n.dt-group-runs-dot[data-state='done'] { background: var(--dsw-alias-state-success-primary); }\r\n.dt-group-runs-dot[data-state='error'] { background: var(--dsw-alias-state-error-primary); }\r\n.dt-group-runs-dot[data-state='cut'] { background: var(--dsw-alias-state-warn-primary); }\r\n.dt-group-runs-meta { display: flex; flex-wrap: wrap; gap: 8px; font-size: 11px; color: var(--dsw-alias-label-tertiary); }\r\n.dt-group-runs-members { display: flex; flex-wrap: wrap; gap: 4px; }\r\n.dt-group-runs-member { border-radius: 999px; padding: 2px 7px; font-size: 10.5px; border: 1px solid var(--dsw-alias-border-l3); white-space: nowrap; }\r\n.dt-group-runs-member[data-state='failed'] { color: var(--dsw-alias-state-error-primary); border-color: var(--dsw-alias-state-error-primary); }\r\n.dt-group-runs-latest { font-size: 11px; color: var(--dsw-alias-label-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }\r\n@keyframes dt-group-runs-live { 0%, 100% { opacity: 1 } 50% { opacity: 0.4 } }\r\n@media (prefers-reduced-motion: reduce) {\r\n  .dt-group-runs-dot { animation: none !important; }\r\n}\r\n";
		//#endregion
		//#region src/core/reasons.ts
		/**
		* Structured reason codes and templates for decisions, filtered triggers, and ended assignments.
		* Policy gates and source scopes may also emit their own literal reason codes.
		*/
		const REASONS = {
			said: "{text}",
			timeout: "Assessment timed out",
			policyChanged: "Policy changed during assessment",
			noAdmissible: "No admissible trigger",
			startedTicket: "Already started ticket {ticket}",
			acceptedBefore: "Trigger {trigger} was accepted before",
			routed: "Routed to ticket {ticket}",
			explicitRouted: "Explicit request from an allowed sender routed by the orchestrator",
			humanStop: "Human asked to stop",
			legacyImport: "Imported from the pre-domain-model task record",
			forwarded: "Forwarded to the worker of the Ticket already on this Thread",
			senderNotMember: "The sender is not on the Source's list",
			retried: "Retried by a person",
			hostRestarted: "dsh-superagent restarted",
			stopUnknown: "Stop target is unknown or already ended",
			stopNotExplicit: "A stop needs an explicit request from a sender on the list",
			directionUnsettled: "Implementation intent or target direction is not established, or a product/design decision is still required",
			noRuleMatched: "No enabled admission rule matched",
			ignoredFromCard: "Ignored from its card, without a rule assessment",
			observed: "Observe mode: would accept ({text})"
		};
		/** Formats reasons in English (prefixed by `triggerId` when present) for agent consumption. */
		function reasonText(reasons) {
			return [reasons ?? []].flat().map((reason) => {
				const text = (REASONS[reason.code] ?? reason.code).replace(/\{(\w+)\}/g, (match, name) => reason.values?.[name] ?? match);
				return reason.triggerId ? `${reason.triggerId}: ${text}` : text;
			}).join("; ");
		}
		//#endregion
		//#region src/client/text.ts
		const errorText = (failure) => failure instanceof Error ? failure.message : String(failure);
		const localized = (t, text) => typeof text === "string" ? text : text ? text[t("lang") === "en" ? "en" : "zh"] : "";
		const actorName = (t, actor) => actor?.name ? localized(t, actor.name) : t("automatedNotice");
		function valueLabel(t, group, key) {
			if (!key) return "";
			const name = `${group}.${key}`;
			const text = t(name);
			return text === name ? key : text;
		}
		/** Format one or more structured or raw reasons in the active UI language, truncating multi-line host errors to their first line. */
		function reasonLabel(t, reason) {
			if (typeof reason === "string") return reason ? label(t, { code: reason }) : "";
			return [reason ?? []].flat().map((item) => label(t, item)).filter(Boolean).join("；");
		}
		function label(t, reason) {
			const key = `reason.${reason.code}`;
			const text = reason.code === "said" ? reason.values?.text ?? "" : t(key, reason.values);
			if (reason.code !== "said" && text !== key) return text;
			const written = reason.code === "said" ? text : reasonText({
				...reason,
				triggerId: void 0
			});
			if (/^\w*Error\b/.test(written)) {
				const first = written.split("\n")[0];
				return first.length > 140 ? `${first.slice(0, 140)}…` : first;
			}
			return written;
		}
		const setupText = (t, problem) => t(`setup.${problem.code}`, problem.values);
		const healthText = (t, health) => health.code ? t(`healthCode.${health.code}`, health.values) : health.detail;
		/** Replaces Feishu and GitHub content placeholders (images, cards, media, forwards, unresolved mentions) with localized labels. */
		function readableMarkers(t, text) {
			return text.replace(/!\[[^\]]*\]\([^)]*\)|\[Image: [^\]]*\]|\[image\]/g, t("imageMarker")).replace(/\[Chat card: [^\]]*\]/g, t("cardMarker")).replace(/\[Media: [^\]]*\]/g, t("mediaMarker")).replace(/\[Merged forward\]/g, t("forwardMarker")).replace(/@_user_\d+/g, t("unknownMention"));
		}
		const timeLocale = (lang) => lang === "en" ? "en" : "zh-CN";
		function when(value, lang) {
			if (!value) return "";
			const date = new Date(value);
			if (Number.isNaN(date.getTime())) return value;
			const seconds = Math.round((date.getTime() - Date.now()) / 1e3);
			if (Math.abs(seconds) < 86400) {
				const relative = new Intl.RelativeTimeFormat(timeLocale(lang), { numeric: "auto" });
				if (Math.abs(seconds) < 60) return relative.format(0, "second");
				if (Math.abs(seconds) < 3600) return relative.format(Math.round(seconds / 60), "minute");
				return relative.format(Math.round(seconds / 3600), "hour");
			}
			const year = date.getFullYear() === (/* @__PURE__ */ new Date()).getFullYear() ? {} : { year: "numeric" };
			return date.toLocaleString(timeLocale(lang), {
				...year,
				month: "short",
				day: "numeric",
				hour: "2-digit",
				minute: "2-digit"
			});
		}
		function fullTime(value, lang) {
			const date = new Date(value ?? "");
			return Number.isNaN(date.getTime()) ? "" : date.toLocaleString(timeLocale(lang));
		}
		//#endregion
		//#region src/client/provider.tsx
		/** Shared panel React contexts, state polling, restart detection, and action runner hook. */
		const Panel = (0, react.createContext)(void 0);
		const PanelState = (0, react.createContext)(void 0);
		function usePanel() {
			const value = (0, react.useContext)(Panel);
			if (!value) throw new Error("dsh-superagent page rendered outside its panel");
			return value;
		}
		function usePanelData() {
			const value = (0, react.useContext)(PanelState);
			if (!value) throw new Error("dsh-superagent page rendered outside its panel");
			return value;
		}
		/** Wrap an async action with re-entrancy protection, busy state, optional reload, and error toast reporting. */
		function useAction(action, { reload } = {}) {
			const { notify } = usePanel();
			const [busy, setBusy] = (0, react.useState)(false);
			const running = (0, react.useRef)(false);
			const run = async (...args) => {
				if (running.current) return false;
				running.current = true;
				setBusy(true);
				try {
					await action(...args);
					await reload?.();
					return true;
				} catch (failure) {
					notify(errorText(failure));
					return false;
				} finally {
					running.current = false;
					setBusy(false);
				}
			};
			return {
				run,
				busy
			};
		}
		const messages = (t) => ({
			offline: t("offline"),
			notRunning: t("hostNotRunning"),
			serverError: (status) => t("serverError", { status }),
			requestFailed: (status) => t("requestFailed", { status }),
			setup: (problem) => problem.values.output ? `${setupText(t, problem)}\n${problem.values.output}` : setupText(t, problem),
			user: ({ code, values }) => t(`userError.${code}`, values.part ? {
				...values,
				part: valueLabel(t, "promptPart", values.part)
			} : values)
		});
		function Toast({ text, onDone, holdMs = 3e3 }) {
			const done = (0, react.useRef)(onDone);
			done.current = onDone;
			(0, react.useEffect)(() => {
				const timer = setTimeout(() => done.current(), holdMs + 1e3);
				return () => clearTimeout(timer);
			}, [holdMs]);
			return (0, react_dom.createPortal)(/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: "dt-toast",
				role: "status",
				style: { ["--dt-toast-hold"]: `${holdMs}ms` },
				children: text
			}), document.body);
		}
		const stay = () => {};
		const noSession = async () => {};
		const STYLE_ID = "dsh-superagent-card-styles";
		/**
		* VsSaros addition (plan C): the panel's context for a card shown outside the panel, in the supervisor desk's DSH
		* conversation: the API and the translator without the panel's state polling, and the panel's styles added to the page once.
		*/
		function CardProvider({ t, openSession = noSession, children }) {
			const copy = (0, react.useRef)(t);
			copy.current = t;
			const call = (0, react.useMemo)(() => caller(() => messages(copy.current)), []);
			const [toast, setToast] = (0, react.useState)();
			const notify = (0, react.useCallback)((text) => setToast({
				text,
				id: Date.now()
			}), []);
			(0, react.useEffect)(() => {
				if (document.getElementById(STYLE_ID)) return;
				const style = document.createElement("style");
				style.id = STYLE_ID;
				style.textContent = client_default;
				document.head.append(style);
			}, []);
			const context = (0, react.useMemo)(() => ({
				t,
				call,
				navigate: stay,
				back: stay,
				backLabel: "",
				openSession,
				notify,
				restart: stay
			}), [
				t,
				call,
				openSession,
				notify
			]);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(Panel.Provider, {
				value: context,
				children: [children, toast && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Toast, {
					text: toast.text,
					onDone: () => setToast(void 0)
				}, toast.id)]
			});
		}
		function PanelProvider({ t, interval = 5e3, openSession = noSession, navigate = stay, back = stay, backLabel = "", children }) {
			const copy = (0, react.useRef)(t);
			copy.current = t;
			const call = (0, react.useMemo)(() => caller(() => messages(copy.current)), []);
			const [toast, setToast] = (0, react.useState)();
			const notify = (0, react.useCallback)((text) => setToast({
				text,
				id: Date.now()
			}), []);
			const [restarting, setRestarting] = (0, react.useState)();
			const [restarts, setRestarts] = (0, react.useState)(0);
			const restart = (0, react.useCallback)(() => setRestarting({ down: false }), []);
			const { data: state, error, reload } = usePoll(() => call("GET state"), [call], restarting ? 1e3 : interval);
			if (restarting && !!error !== restarting.down) {
				setRestarting(error ? { down: true } : void 0);
				if (!error) setRestarts(restarts + 1);
			}
			(0, react.useEffect)(() => {
				if (!restarting) return;
				const timer = setTimeout(() => setRestarting(void 0), 3e4);
				return () => clearTimeout(timer);
			}, [restarting]);
			const context = (0, react.useMemo)(() => ({
				t,
				call,
				navigate,
				back,
				backLabel,
				openSession,
				notify,
				restart
			}), [
				t,
				call,
				navigate,
				back,
				backLabel,
				openSession,
				notify,
				restart
			]);
			const data = (0, react.useMemo)(() => ({
				state,
				error,
				reload,
				setup: state?.setup,
				running: state?.load.running ?? 0,
				restarts
			}), [
				state,
				error,
				reload,
				restarts
			]);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Panel.Provider, {
				value: context,
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(PanelState.Provider, {
					value: data,
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("style", { children: client_default }),
						children,
						toast && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Toast, {
							text: toast.text,
							onDone: () => setToast(void 0)
						}, toast.id)
					]
				})
			});
		}
		//#endregion
		//#region src/client/draft.tsx
		/**
		* Optimistic settings draft state with sessionStorage persistence and three-way rebase against concurrent saves.
		*/
		const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
		const isRecord = (value) => !!value && typeof value === "object" && !Array.isArray(value);
		const LIST_KEYS = ["id", "chatId"];
		const named = (list, field) => list.every((item) => isRecord(item) && typeof item[field] === "string") && new Set(list.map((item) => item[field])).size === list.length;
		/**
		* Three-way merge between `base`, local `mine`, and remote `theirs`.
		* Merges objects by key and arrays of keyed records (`id` or `chatId`) by element: a key or element removed by one side is
		* deleted if the other side left it unchanged; a removal against a modification keeps `mine` and is recorded in `conflicts`.
		*/
		function merge3(base, mine, theirs, conflicts = [], path = []) {
			if (same(mine, base) || same(mine, theirs)) return theirs;
			if (same(theirs, base)) return mine;
			if (Array.isArray(mine) && Array.isArray(theirs) && (base === void 0 || Array.isArray(base))) {
				const lists = [
					base ?? [],
					mine,
					theirs
				];
				const field = LIST_KEYS.find((name) => lists.every((list) => named(list, name)));
				if (field) return mergeList(lists, field, conflicts, path);
			}
			if (!isRecord(base) || !isRecord(mine) || !isRecord(theirs)) {
				conflicts.push(path);
				return mine;
			}
			const merged = {};
			for (const key of /* @__PURE__ */ new Set([...Object.keys(theirs), ...Object.keys(mine)])) {
				const value = merge3(base[key], mine[key], theirs[key], conflicts, [...path, key]);
				if (value !== void 0) merged[key] = value;
			}
			return merged;
		}
		function mergeList([base, mine, theirs], field, conflicts, path) {
			const name = (item) => String(item[field]);
			const [before, ours, others] = [
				base,
				mine,
				theirs
			].map((list) => new Map(list.map((item) => [name(item), item])));
			const order = theirs.map(name);
			mine.forEach((item, index) => {
				if (order.includes(name(item))) return;
				const previous = mine.slice(0, index).map(name).reverse().find((key) => order.includes(key));
				order.splice(previous === void 0 ? 0 : order.indexOf(previous) + 1, 0, name(item));
			});
			return order.flatMap((key) => {
				const value = merge3(before.get(key), ours.get(key), others.get(key), conflicts, [...path, key]);
				return value === void 0 ? [] : [value];
			});
		}
		function read(key) {
			if (!key) return void 0;
			try {
				const stored = JSON.parse(sessionStorage.getItem(key) ?? "null");
				return stored && "base" in stored && "value" in stored && Number.isInteger(stored.revision) ? stored : void 0;
			} catch (error) {
				return;
			}
		}
		const FAILURES = /* @__PURE__ */ new Set([
			"conflict",
			"invalid",
			"failed",
			"unstored"
		]);
		/**
		* State machine for a settings draft.
		* Holds submitted values in `awaitingRevision` until the polled revision catches up, and rebases active edits onto newer remote revisions via `merge3`.
		*/
		function draftReducer(state, action) {
			const { phase, draft, seen } = state;
			switch (action.type) {
				case "edit":
					if (phase === "saving" || phase === "awaitingRevision") return state;
					if (same(action.value, action.saved)) return {
						phase: "clean",
						seen
					};
					return {
						phase: "editing",
						seen,
						notice: state.notice && FAILURES.has(state.notice.kind) ? state.notice : void 0,
						draft: {
							base: draft?.base ?? action.saved,
							value: action.value,
							revision: draft?.revision ?? action.revision ?? 0,
							...action.meta === void 0 ? {} : { meta: action.meta }
						}
					};
				case "discard": return phase === "saving" || phase === "awaitingRevision" ? state : {
					phase: "clean",
					seen
				};
				case "submit": return phase === "editing" ? {
					...state,
					phase: "saving"
				} : state;
				case "saved": return phase === "saving" && draft ? {
					phase: "awaitingRevision",
					seen,
					sent: {
						value: draft.value,
						revision: action.revision,
						restarting: action.restarting
					}
				} : state;
				case "refused": return {
					...state,
					phase: phase === "saving" ? "editing" : phase,
					notice: action.notice
				};
				case "revisionArrived": {
					if (phase === "saving") return state;
					const { revision, saved } = action;
					if (state.sent) return revision >= state.sent.revision ? {
						phase: "clean",
						seen: revision
					} : {
						...state,
						seen: revision
					};
					if (!draft || draft.revision === revision) return {
						...state,
						seen: revision
					};
					const paths = [];
					const value = merge3(draft.base, draft.value, saved, paths);
					if (same(value, saved)) return {
						phase: "clean",
						seen: revision
					};
					return {
						phase: "editing",
						seen: revision,
						draft: {
							...draft,
							base: saved,
							value,
							revision
						},
						notice: paths.length ? {
							kind: "conflict",
							revision,
							paths
						} : {
							kind: "merged",
							revision
						}
					};
				}
			}
		}
		function saveBarText(t, { phase, sent, notice }, words = {}) {
			switch (notice?.kind) {
				case "conflict": return {
					error: words.conflict?.(notice.revision, notice.paths) ?? t("saveConflict"),
					status: ""
				};
				case "invalid": return {
					error: t("invalidSettings", { fields: notice.fields.join(t("listSeparator")) }),
					status: ""
				};
				case "failed": return {
					error: notice.error,
					status: ""
				};
				case "unstored": return {
					error: t("draftFailed", { error: notice.error }),
					status: ""
				};
				case "merged": return { status: words.merged?.(notice.revision) ?? t("saveMerged") };
				case "rebasing": return { status: t("saveRebasing") };
			}
			if (phase === "awaitingRevision") return { status: t(sent?.restarting ? "savedRestarting" : "saved") };
			return { status: phase === "clean" ? t("saved") : words.editing ?? t(notice?.kind === "restored" ? "draftRestored" : "draftKept") };
		}
		/** Manage a settings draft, persisting unsaved edits in `sessionStorage` and rebasing them when newer server revisions arrive. */
		function useDraft({ key, saved, revision, save, reload }) {
			const { restart } = usePanel();
			const [state, dispatch] = (0, react.useReducer)(draftReducer, void 0, () => {
				const stored = read(key);
				const initial = stored ? {
					phase: "editing",
					draft: stored,
					notice: { kind: "restored" }
				} : { phase: "clean" };
				return revision === void 0 ? initial : draftReducer(initial, {
					type: "revisionArrived",
					saved,
					revision
				});
			});
			if (state.phase !== "saving" && revision !== void 0 && revision !== state.seen) dispatch({
				type: "revisionArrived",
				saved,
				revision
			});
			(0, react.useEffect)(() => {
				if (!key) return;
				try {
					if (state.draft) sessionStorage.setItem(key, JSON.stringify(state.draft));
					else sessionStorage.removeItem(key);
				} catch (failure) {
					dispatch({
						type: "refused",
						notice: {
							kind: "unstored",
							error: errorText(failure)
						}
					});
				}
			}, [key, state.draft]);
			const failed = (failure) => dispatch({
				type: "refused",
				notice: {
					kind: "failed",
					error: errorText(failure)
				}
			});
			const submit = async (event) => {
				event?.preventDefault();
				const { draft } = state;
				if (state.phase !== "editing" || !draft) return;
				dispatch({ type: "submit" });
				let result;
				try {
					result = await save(draft.value, draft.revision, draft.base);
				} catch (failure) {
					const fields = failure instanceof ApiError ? failure.issues.map((issue) => issue.path) : [];
					if (failure instanceof ApiError && failure.status === 409) await reload().then(() => dispatch({
						type: "refused",
						notice: { kind: "rebasing" }
					}), failed);
					else dispatch({
						type: "refused",
						notice: fields.length ? {
							kind: "invalid",
							fields
						} : {
							kind: "failed",
							error: errorText(failure)
						}
					});
					return;
				}
				dispatch({
					type: "saved",
					revision: result.revision,
					restarting: !!result.restarting
				});
				if (result.restarting) restart();
				else await reload().catch(failed);
			};
			return {
				state,
				value: state.sent?.value ?? state.draft?.value ?? saved,
				meta: state.draft?.meta,
				revision: state.draft?.revision ?? revision ?? 0,
				dirty: state.draft !== void 0,
				busy: state.phase === "saving" || state.phase === "awaitingRevision",
				submit,
				edit: (value, meta) => dispatch({
					type: "edit",
					value,
					meta,
					saved,
					revision
				}),
				discard: () => dispatch({ type: "discard" })
			};
		}
		/** Sticky save/discard bar for a settings block; transfers focus back to its parent block when hidden so keyboard navigation does not reset. */
		function SaveBar({ state, dirty, busy, words, status, onDiscard, onSave }) {
			const { t } = usePanel();
			const line = saveBarText(t, state, words);
			const shown = dirty || busy || !!line.error;
			const bar = (0, react.useRef)(null);
			const block = (0, react.useRef)(null);
			const focused = (0, react.useRef)(false);
			(0, react.useLayoutEffect)(() => {
				if (shown) {
					block.current = bar.current?.parentElement ?? null;
					return;
				}
				const lost = !document.activeElement || document.activeElement === document.body;
				if (focused.current && block.current && lost) {
					block.current.tabIndex = -1;
					block.current.focus({ preventScroll: true });
				}
				focused.current = false;
			}, [shown]);
			if (!shown) return null;
			const leave = (next) => {
				if (next && !bar.current?.contains(next)) focused.current = false;
			};
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				ref: bar,
				className: "dt-savebar",
				onFocus: () => {
					focused.current = true;
				},
				onBlur: (event) => leave(event.relatedTarget),
				children: [
					line.error ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: "dt-error dt-clamp",
						role: "alert",
						children: line.error
					}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: "dt-hint",
						"aria-live": "polite",
						children: status ?? line.status
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Button, {
						variant: "ghost",
						size: "sm",
						disabled: !dirty || busy,
						onClick: onDiscard,
						children: t("discard")
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Button, {
						variant: "primary",
						size: "sm",
						disabled: !dirty || busy,
						...onSave ? { onClick: onSave } : { type: "submit" },
						children: t("save")
					})
				]
			});
		}
		//#endregion
		//#region src/client/marks.ts
		function ticketMark(t, ticket) {
			switch (ticket.stage) {
				case "ended": return {
					label: valueLabel(t, "outcome", ticket.ended?.outcome),
					tone: "neutral",
					dot: "idle",
					icon: "stop"
				};
				case "person": {
					const action = ticket.action;
					const icon = action === "review" ? "review" : action === "failed" ? "alert" : action === "blocked" ? "blocked" : action === "delivery" ? "inbox" : action === "staffing" ? "review" : "ask";
					return {
						label: t(`stage.${action}`),
						tone: action === "failed" ? "danger" : "warning",
						dot: action === "failed" ? "error" : "warning",
						icon
					};
				}
				case "working": return ticket.action === "queued" ? {
					label: t("stage.queued"),
					tone: "neutral",
					dot: "idle",
					icon: "queue"
				} : {
					label: t("stage.working"),
					tone: "info",
					dot: "ongoing",
					icon: "running"
				};
				default: return {
					label: t("stage.idle"),
					tone: "neutral",
					dot: "idle",
					icon: "clock"
				};
			}
		}
		const reportDot = (report) => report === "failed" ? "error" : report === "blocked" || report === "waiting" ? "warning" : report === "ready" ? "done" : "ongoing";
		const THREAD_MARKS = {
			error: {
				dot: "error",
				icon: "alert",
				label: "threadPollFailed"
			},
			evaluating: {
				dot: "ongoing",
				icon: "running",
				label: "threadEvaluating"
			},
			queued: {
				dot: "warning",
				icon: "queue",
				label: "threadQueued"
			},
			subscribed: {
				dot: "done",
				icon: "inbox",
				label: "threadSubscribed"
			},
			dormant: {
				dot: "idle",
				icon: "clock",
				label: "threadDormantShort"
			},
			unsubscribed: {
				dot: "idle",
				icon: "hash",
				label: "threadUnsubscribed"
			}
		};
		function threadMark(t, thread) {
			const { dot, icon, label } = THREAD_MARKS[thread.stage];
			return {
				dot,
				icon,
				label: t(label, { count: thread.pending })
			};
		}
		const SOURCE_MARKS = {
			missing: {
				dot: "idle",
				label: "sourceNotInstalled"
			},
			off: {
				dot: "idle",
				label: "sourceOff"
			},
			error: {
				dot: "error",
				label: "sourceState.error"
			},
			setup: {
				dot: "idle",
				label: "sourceState.setup"
			},
			starting: {
				dot: "ongoing",
				label: "sourceState.ongoing"
			},
			paused: {
				dot: "warning",
				label: "sourceState.warning"
			},
			ready: {
				dot: "done",
				label: "sourceState.done"
			}
		};
		const sourceMark = (t, state) => ({
			dot: SOURCE_MARKS[state].dot,
			label: t(SOURCE_MARKS[state].label)
		});
		const DECISION_MARKS = {
			accept: {
				dot: "done",
				icon: "decision",
				tone: "success"
			},
			reopen: {
				dot: "done",
				icon: "refresh",
				tone: "success"
			},
			stop: {
				dot: "idle",
				icon: "stop",
				tone: "danger"
			},
			ignore: {
				dot: "idle",
				icon: "dismiss",
				tone: "neutral"
			},
			unavailable: {
				dot: "warning",
				icon: "alert",
				tone: "warning"
			},
			wouldAccept: {
				dot: "idle",
				icon: "dismiss",
				tone: "warning"
			}
		};
		/** Maps a Decision outcome to its visual mark, distinguishing `wouldAccept` (an ignore that observe mode would have accepted). */
		function decisionMark(t, outcome) {
			return {
				...DECISION_MARKS[outcome],
				label: outcome === "wouldAccept" ? t("wouldAccept") : valueLabel(t, "decision", outcome)
			};
		}
		//#endregion
		//#region src/client/markdown.ts
		function shortUrl(url) {
			try {
				const parsed = new URL(url);
				const path = parsed.pathname.length > 24 ? `${parsed.pathname.slice(0, 24)}…` : parsed.pathname;
				return `${parsed.host}${path === "/" ? "" : path}`;
			} catch (error) {
				return url;
			}
		}
		/** Splits plain text into text and bare-URL link nodes, excluding trailing sentence punctuation from URLs. */
		function linkify(text) {
			return text.split(/(https?:\/\/[^\s)，。]*[^\s)，。.,;:!?'"])/).filter(Boolean).map((part) => /^https?:\/\//.test(part) ? {
				kind: "link",
				text: shortUrl(part),
				url: part
			} : {
				kind: "text",
				text: part
			});
		}
		function inlines(text) {
			return text.split(/(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\(https?:\/\/[^)\s]+\))/).flatMap((part) => {
				if (/^\*\*[^*]+\*\*$/.test(part)) return [{
					kind: "bold",
					text: part.slice(2, -2)
				}];
				if (/^`[^`]+`$/.test(part)) return [{
					kind: "code",
					text: part.slice(1, -1)
				}];
				const link = /^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)$/.exec(part);
				return link ? [{
					kind: "link",
					text: link[1],
					url: link[2]
				}] : linkify(part);
			});
		}
		function markdownBlocks(text) {
			const blocks = [];
			let list;
			for (const line of text.split("\n")) {
				const item = /^\s*[-*]\s+(.*)$/.exec(line) ?? /^\s*\d+[.)]\s+(.*)$/.exec(line);
				if (item) {
					const ordered = !/^\s*[-*]/.test(line);
					if (!list || list.ordered !== ordered) blocks.push(list = {
						kind: "list",
						ordered,
						items: []
					});
					list.items.push(item[1]);
					continue;
				}
				list = void 0;
				const heading = /^#{1,6}\s+(.*)$/.exec(line);
				if (line.trim()) blocks.push(heading ? {
					kind: "heading",
					text: heading[1]
				} : {
					kind: "paragraph",
					text: line
				});
			}
			return blocks;
		}
		//#endregion
		//#region src/app/api.ts
		const TICKET_FILTERS = [
			"open",
			"person",
			"working",
			"idle",
			"ended"
		];
		const THREAD_FILTERS = [
			"subscribed",
			"evaluating",
			"recent",
			"all"
		];
		/**
		* VsSaros change (2026-11-07, user request): the tabs the header shows. The Workbench (`work`) is no longer a tab.
		* ★ 2026-11-09: its three views (flow / board / list) now live INSIDE the `execution` tab; `work` remains only as a
		*   legacy route alias that `parseRoute` normalizes to `execution` (see below), so old links and stored routes still work.
		*/
		const NAV_TABS = [
			"chat",
			"work",
			"source",
			"trigger",
			"eval",
			"execution",
			"settings"
		].filter((tab) => tab !== "work");
		const SETTINGS_GROUPS = [
			"source",
			"eval",
			"execution",
			"prompts",
			"deployment"
		];
		const HOME = { page: "chat" };
		const settingsRoute = (group, query = {}) => ({
			page: "settings",
			query: {
				group,
				...query
			}
		});
		const setupPage = (place) => place === "deployment" ? settingsRoute("deployment") : settingsRoute("source", { source: place });
		const routeLabel = (t, route) => route.id ? t(route.page === "trigger" ? "term.thread" : "term.ticket") : t(`tab.${route.page}`);
		const pick = (values, value) => values.find((item) => item === value);
		function compact(query) {
			const set = Object.entries(query).filter(([, value]) => value !== void 0);
			return set.length ? Object.fromEntries(set) : void 0;
		}
		/** Validate and normalize a stored route, dropping unrecognized query filters or removed tabs (such as the legacy `policy` tab). */
		function parseRoute(value) {
			const { page, id, query } = value ?? {};
			const text = (name) => typeof query?.[name] === "string" ? query[name] : void 0;
			const record = typeof id === "string" && id ? id : void 0;
			switch (page) {
				case "chat":
				case "source": return { page };
				case "work": return {
					page: "execution",
					query: compact({ ticket: text("ticket") })
				};
				case "overview": return { page: "chat" };
				case "trigger": return record ? {
					page,
					id: record,
					query: compact({ trigger: text("trigger") })
				} : {
					page,
					query: compact({ filter: pick(THREAD_FILTERS, query?.filter) })
				};
				case "eval": return {
					page,
					query: compact({
						filter: pick(DECISION_FILTERS, query?.filter),
						window: query?.window === "24h" ? "24h" : void 0
					})
				};
				case "execution": return record ? {
					page,
					id: record
				} : {
					page,
					query: compact({
						filter: pick(TICKET_FILTERS, query?.filter),
						ticket: text("ticket")
					})
				};
				case "settings": return {
					page,
					query: {
						group: pick(SETTINGS_GROUPS, query?.group) ?? "source",
						...compact({
							source: text("source"),
							version: text("version")
						})
					}
				};
				default: return;
			}
		}
		const ROUTE_KEY = "dsh-superagent/route";
		const lastSettingsGroup = ({ route, group }) => route.page === "settings" ? route.query.group : group ?? "source";
		function initialLocation() {
			try {
				const stored = JSON.parse(sessionStorage.getItem(ROUTE_KEY) ?? "null");
				const route = parseRoute(stored?.route);
				const stack = Array.isArray(stored?.stack) ? stored.stack : [];
				if (route) return {
					route,
					stack: stack.flatMap((item) => parseRoute(item) ?? []),
					group: pick(SETTINGS_GROUPS, stored?.group)
				};
			} catch (error) {}
			return {
				route: HOME,
				stack: []
			};
		}
		function remember(location) {
			try {
				sessionStorage.setItem(ROUTE_KEY, JSON.stringify(location));
			} catch (failure) {}
		}
		//#endregion
		//#region src/client/widgets.tsx
		/** Context-aware shared UI widgets: page/section headers, timestamps, Markdown rendering, and confirmation actions. */
		const external = {
			target: "_blank",
			rel: "noopener noreferrer"
		};
		function When({ at }) {
			const { t } = usePanel();
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("time", {
				dateTime: at,
				title: fullTime(at, t("lang")),
				children: when(at, t("lang"))
			});
		}
		function SetupMessage({ problem, lead }) {
			const { t } = usePanel();
			const text = setupText(t, problem);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [lead ? t("setupProblem", { detail: text }) : text, problem.values.output && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				className: "dt-detail dt-mono dt-clamp",
				children: problem.values.output
			})] });
		}
		function Section({ title, count, children, action, hint, badge, icon }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
				className: "dt-section",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("h2", {
					className: "dt-section-title",
					children: [
						icon && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "dt-section-icon",
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Icon, {
								name: icon,
								size: 14
							})
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "dt-section-name",
							children: title
						}),
						count !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "dt-count",
							children: count
						}),
						hint && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(InfoTip, { text: hint }),
						badge,
						action && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: { marginLeft: "auto" },
							children: action
						})
					]
				}), children]
			});
		}
		function Hint({ children }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
				className: "dt-hint",
				children
			});
		}
		function LabelValue({ label, value }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
				className: "dt-lv",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "dt-lv-label",
						children: label
					}),
					" ",
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "dt-lv-value",
						children: value
					})
				]
			});
		}
		function KeyValues({ rows }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("dl", {
				className: "dt-kv",
				children: rows.map(([key, value], index) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					style: { display: "contents" },
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("dt", { children: key }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("dd", { children: value })]
				}, index))
			});
		}
		function Inlines({ parts }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(react_jsx_runtime.Fragment, { children: parts.map((part, index) => part.kind === "bold" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: part.text }, index) : part.kind === "code" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", {
				className: "dt-code",
				children: part.text
			}, index) : part.kind === "link" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("a", {
				className: "dt-inline-link",
				href: part.url,
				title: part.url,
				...external,
				children: part.text
			}, index) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(react.Fragment, { children: part.text }, index)) });
		}
		/** Renders a safe Markdown subset (headings, lists, paragraphs, bold, inline code, links) without interpreting raw HTML. */
		function MarkdownLite({ text }) {
			const { t } = usePanel();
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: "dt-md",
				children: markdownBlocks(readableMarkers(t, text)).map((block, index) => {
					if (block.kind !== "list") return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: block.kind === "heading" ? "dt-md-heading" : void 0,
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Inlines, { parts: inlines(block.text) })
					}, index);
					const items = block.items.map((item, at) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("li", { children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Inlines, { parts: inlines(item) }) }, at));
					return block.ordered ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("ol", { children: items }, index) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("ul", { children: items }, index);
				})
			});
		}
		function MoreToggle({ open, onToggle }) {
			const { t } = usePanel();
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
				type: "button",
				className: "dt-textlink dt-more",
				"aria-expanded": open,
				onClick: onToggle,
				children: open ? t("collapse") : t("expand")
			});
		}
		function ClampText({ text }) {
			const [open, setOpen] = (0, react.useState)(false);
			const long = text.length > 480 || text.split("\n").length > 8;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: long && !open ? "dt-event-text dt-clamp-8" : "dt-event-text",
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Inlines, { parts: linkify(text) })
			}), long && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(MoreToggle, {
				open,
				onToggle: () => setOpen(!open)
			})] });
		}
		function ConfirmButton({ label, title, message, onConfirm, variant = "ghost", icon }) {
			const { t } = usePanel();
			const [open, setOpen] = (0, react.useState)(false);
			const confirm = useAction(onConfirm);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Button, {
				variant,
				size: "sm",
				icon: icon && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Icon, {
					name: icon,
					size: 14
				}),
				onClick: () => setOpen(true),
				children: label
			}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Modal, {
				open,
				onClose: () => setOpen(false),
				title,
				closeLabel: t("close"),
				description: message,
				footer: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Button, {
					variant: "ghost",
					onClick: () => setOpen(false),
					children: t("cancel")
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Button, {
					variant: "primary",
					disabled: confirm.busy,
					onClick: () => {
						confirm.run().then((done) => {
							if (done) setOpen(false);
						});
					},
					children: t("confirm")
				})] })
			})] });
		}
		function SessionButton({ sessionId, label, variant = "ghost" }) {
			const { t, openSession, notify } = usePanel();
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Button, {
				variant,
				size: "sm",
				icon: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Icon, {
					name: "session",
					size: 14
				}),
				onClick: () => {
					openSession(sessionId).catch((error) => notify(errorText(error)));
				},
				children: label ?? t("openSession")
			});
		}
		function ExternalLink({ href, children, icon = "external" }) {
			const label = /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Icon, {
				name: icon,
				size: 13
			}), children] });
			if (!href) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				className: "dt-inline-link dt-icon-link",
				"data-vssaros-no-link": "1",
				children: label
			});
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("a", {
				className: "dt-inline-link dt-icon-link",
				href,
				...external,
				children: label
			});
		}
		/**
		* A link to answer/open in an external Channel. When the Channel has no external URL (superagent desk),
		* `onActivate` turns it into an in-app button instead — see the note on ExternalLink.
		*/
		function ActionLink({ href, children, icon = "external", onActivate }) {
			const label = /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				className: "dt-btn-icon",
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Icon, {
					name: icon,
					size: 14
				})
			}), children] });
			if (!href) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
				type: "button",
				className: "dt-btn dt-btn-outline dt-btn-sm",
				"data-vssaros-in-app-action": "1",
				disabled: !onActivate,
				onClick: onActivate,
				children: label
			});
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("a", {
				className: "dt-btn dt-btn-outline dt-btn-sm",
				href,
				...external,
				children: label
			});
		}
		function StageMark({ state, icon, label }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
				className: "dt-stage",
				"data-state": state,
				children: [state === "ongoing" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(StateDot, { state: "ongoing" }) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Icon, {
					name: icon,
					size: 14
				}), label]
			});
		}
		function LoadState({ error, loading }) {
			const { t } = usePanel();
			if (error) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
				className: "dt-error",
				role: "alert",
				children: error.message
			});
			return loading ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Hint, { children: t("loading") }) : null;
		}
		function LoadMore({ onMore }) {
			const { t } = usePanel();
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Button, {
				variant: "outline",
				size: "sm",
				icon: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Icon, {
					name: "chevron-down",
					size: 14
				}),
				onClick: onMore,
				children: t("loadMore")
			});
		}
		function StatusHead({ hint, settings }) {
			const { t, navigate } = usePanel();
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "dt-status-head",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("h2", {
					className: "dt-status-title",
					children: [t("statusTitle"), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(InfoTip, { text: hint })]
				}), settings && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Button, {
					variant: "ghost",
					size: "sm",
					icon: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Icon, { name: "settings" }),
					onClick: () => navigate(settingsRoute(settings)),
					children: t("tab.settings")
				})]
			});
		}
		function PageHead({ title, children }) {
			const { back, backLabel } = usePanel();
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "dt-page-head",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Button, {
					variant: "ghost",
					size: "sm",
					icon: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Icon, { name: "chevron-left" }),
					onClick: back,
					children: backLabel
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "dt-page-title",
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h2", { children: title }), children && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "dt-actions",
						children
					})]
				})]
			});
		}
		/** Trigger a host setup re-check and restart, prompting for confirmation when running Assignments would be interrupted. */
		function CheckSetupButton() {
			const { t, call, notify, restart } = usePanel();
			const { running } = usePanelData();
			const check = async () => {
				await call("POST setup/check");
				notify(t("setupChecking"));
				restart();
			};
			const action = useAction(check);
			if (running > 0) {
				const message = t("setupCheckInterrupts", { count: running });
				return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ConfirmButton, {
					variant: "outline",
					icon: "refresh",
					label: t("setupCheck"),
					title: t("setupCheck"),
					message,
					onConfirm: check
				});
			}
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Button, {
				variant: "outline",
				size: "sm",
				icon: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Icon, {
					name: "refresh",
					size: 14
				}),
				disabled: action.busy,
				onClick: () => {
					action.run();
				},
				children: t("setupCheck")
			});
		}
		//#endregion
		//#region src/client/rows.tsx
		/** Shared list rows for Tickets, Threads, and Decisions, plus Source fact chips and automated-message run folding. */
		function TicketLine({ ticket, question, onChanged, context }) {
			const { t, call, navigate } = usePanel();
			const status = ticketMark(t, ticket);
			const after = async (request) => {
				await request;
				await onChanged?.();
			};
			const note = question && ticket.note && {
				...ticket.note,
				text: readableMarkers(t, ticket.note.text)
			};
			const answer = ticket.reply && ticket.stage === "person" && ticket.action === "answer" ? ticket.reply : void 0;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", {
				className: "dt-row dt-link dt-ticket",
				"data-state": question ? status.dot : void 0,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					className: "dt-ticket-stage",
					children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(StageMark, {
						state: status.dot,
						icon: status.icon,
						label: status.label
					})
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "dt-ticket-body",
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: "dt-row-title",
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: "dt-open",
								onClick: () => navigate({
									page: "execution",
									id: ticket.id
								}),
								children: ticket.title
							})
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "dt-row-meta dt-ticket-meta",
							children: [
								ticket.threads.map((thread) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ThreadChip, { thread }, thread.key)),
								context && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ContextTag, {}),
								ticket.undelivered > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(LabelValue, {
									label: t("ticketUndeliveredLabel"),
									value: ticket.undelivered
								}),
								note ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: note.error ? "dt-ticket-note dt-ticket-note-error" : "dt-ticket-note",
									title: note.text,
									children: note.text
								}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(When, { at: ticket.updatedAt })
							]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: "dt-ticket-actions",
							children: onChanged && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
								answer && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ActionLink, {
									href: answer.url,
									icon: "message",
									onActivate: () => navigate({ page: "chat" }),
									children: t("answerIn", { source: valueLabel(t, "source", answer.source) })
								}),
								ticket.actions.retry && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ConfirmButton, {
									variant: "outline",
									icon: "refresh",
									label: t("retry"),
									title: t("retryTitle"),
									message: t("retryConfirm", { title: ticket.title }),
									onConfirm: () => after(call("POST tickets/:id/retry", { id: ticket.id }))
								}),
								ticket.actions.retry && ticket.sessionId && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(SessionButton, {
									variant: "outline",
									sessionId: ticket.sessionId
								}),
								ticket.actions.stop && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ConfirmButton, {
									variant: "outline",
									icon: "stop",
									label: t("stop"),
									title: t("stopConfirmTitle"),
									message: t("stopConfirm", { title: ticket.title }),
									onConfirm: () => after(call("POST tickets/:id/stop", { id: ticket.id }))
								})
							] })
						})
					]
				})]
			});
		}
		function ContextTag() {
			const { t } = usePanel();
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Tag, {
				tone: "quiet",
				title: t("contextOnlyHint"),
				children: t("contextOnly")
			});
		}
		/** Thread list row; on a Ticket page, `ticketId` omits that Ticket from fanout targets and `context` marks context-only threads. */
		function ThreadLine({ thread, ticketId, context }) {
			const { t, navigate } = usePanel();
			const live = thread.tickets.filter((ticket) => ticket.state === "open" && ticket.id !== ticketId);
			const { dot, icon, label } = threadMark(t, thread);
			const reaches = live.length > 0 && `${live[0].title}${live.length > 1 ? t("andMore", { count: live.length - 1 }) : ""}`;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", {
				className: "dt-row dt-link dt-ticket",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					className: "dt-ticket-stage",
					children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(StageMark, {
						state: dot,
						icon,
						label
					})
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "dt-ticket-body",
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: "dt-row-title",
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: "dt-open",
								title: thread.pollError,
								onClick: () => navigate({
									page: "trigger",
									id: thread.key
								}),
								children: readableMarkers(t, thread.title)
							})
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: "dt-row-quote dt-line",
							children: thread.latest && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
								actorName(t, thread.latest.actor),
								t("labelSeparator"),
								readableMarkers(t, thread.latest.preview) || t("empty")
							] })
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "dt-row-meta dt-line",
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(ThreadChip, { thread }),
								context && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ContextTag, {}),
								thread.pollError ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "dt-line-text dt-error-text",
									children: thread.pollError
								}) : reaches && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(LabelValue, {
									label: t("fanoutTo"),
									value: reaches
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(When, { at: thread.lastAt })
							]
						})
					]
				})]
			});
		}
		function DecisionLine({ decision }) {
			const { t, navigate } = usePanel();
			const matched = decision.rules.filter((rule) => rule.matched).map((rule) => rule.name);
			const mark = decisionMark(t, decision.outcome);
			const preview = readableMarkers(t, decision.preview);
			const reason = decision.reason ? reasonLabel(t, decision.reason) : "";
			const open = () => decision.ticketId ? navigate({
				page: "execution",
				id: decision.ticketId
			}) : navigate({
				page: "trigger",
				id: decision.thread,
				query: { trigger: decision.triggerIds[0] ?? "" }
			});
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", {
				className: "dt-row dt-link dt-ticket",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					className: "dt-ticket-stage",
					children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(StageMark, {
						state: mark.dot,
						icon: mark.icon,
						label: mark.label
					})
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "dt-ticket-body",
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: "dt-row-title",
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: "dt-open",
								title: reason || void 0,
								onClick: open,
								children: decision.ticketTitle ?? (decision.threadTitle ? readableMarkers(t, decision.threadTitle) : preview || t("empty"))
							})
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: "dt-row-quote dt-line",
							children: preview
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "dt-row-meta dt-line",
							children: [
								reason && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "dt-line-text",
									children: reason
								}),
								matched.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(LabelValue, {
									label: t("ruleLabel"),
									value: matched.join(t("listSeparator"))
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(When, { at: decision.at })
							]
						})
					]
				})]
			});
		}
		function ThreadChip({ thread }) {
			const { t } = usePanel();
			const cells = /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				className: "dt-chip-source",
				children: valueLabel(t, "source", thread.source)
			}), Object.entries(thread.facts).map(([id, fact]) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
				className: fact.problem ? "dt-chip-fact dt-chip-problem" : "dt-chip-fact",
				children: [fact.label && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: "dt-chip-label",
					children: localized(t, fact.label)
				}), localized(t, fact.value)]
			}, id))] });
			return thread.url ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("a", {
				className: "dt-chip dt-chip-link",
				href: thread.url,
				target: "_blank",
				rel: "noopener noreferrer",
				title: thread.title,
				children: [cells, /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: "dt-chip-open",
					children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Icon, {
						name: "external",
						size: 11
					})
				})]
			}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				className: "dt-chip",
				children: cells
			});
		}
		/** Group consecutive automated items from the same sender so only the newest is shown by default. */
		function automatedRuns(items, sender) {
			const runs = [];
			for (const item of items) {
				const last = runs.at(-1), from = sender(item);
				if (last && from !== void 0 && sender(last.item) === from) last.earlier.push(item);
				else runs.push({
					item,
					earlier: []
				});
			}
			return runs;
		}
		function Earlier({ items }) {
			const { t } = usePanel();
			const [open, setOpen] = (0, react.useState)(false);
			if (!items.length) return null;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
				type: "button",
				className: "dt-textlink",
				"aria-expanded": open,
				onClick: () => setOpen(!open),
				children: open ? t("collapse") : t("automatedEarlier", { count: items.length })
			}), open && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("ul", {
				className: "dt-plain-list dt-hint",
				children: items.map((item) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", { children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(When, { at: item.at }),
					" · ",
					readableMarkers(t, item.preview) || t("empty")
				] }, item.id))
			})] });
		}
		//#endregion
		//#region src/client/settings-kit.tsx
		/** Shared settings context, block draft hook, form controls, Source schema field renderer, and configuration history. */
		/** Parse a numeric input string, returning `null` when empty so the server rejects blank required numbers instead of coercing to 0. */
		const numberOf = (text) => text.trim() ? Number(text) : null;
		const SettingsContext = (0, react.createContext)(void 0);
		function useSettings() {
			const value = (0, react.useContext)(SettingsContext);
			if (!value) throw new Error("A settings block rendered outside the settings");
			return value;
		}
		function SettingsProvider({ children }) {
			const { call } = usePanel();
			const { restarts } = usePanelData();
			const { data, error, reload } = usePoll(() => call("GET settings"), [call, restarts]);
			if (!data) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(LoadState, {
				error,
				loading: true
			});
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(SettingsContext.Provider, {
				value: {
					settings: data,
					reload
				},
				children: [error && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(LoadState, {
					error,
					loading: false
				}), children]
			});
		}
		function useBlockDraft(block, saved, revision, toValue = (draft) => draft) {
			const { t, call, notify } = usePanel();
			const { state } = usePanelData();
			const { reload } = useSettings();
			return useDraft({
				key: `dsh-superagent/draft/${state?.masterId ?? ""}/${block}`,
				saved,
				revision,
				reload,
				save: async (value, from) => {
					const result = await call("PUT settings/:block", {
						block,
						body: {
							value: toValue(value),
							revision: from
						}
					});
					notify(t(result.restarting ? "savedRestarting" : "saved"));
					return result;
				}
			});
		}
		/** Fieldset wrapper that restores focus to the previously active input after a save completes and re-enables the form. */
		function Fields({ disabled, children }) {
			const set = (0, react.useRef)(null);
			const focused = (0, react.useRef)(null);
			(0, react.useLayoutEffect)(() => {
				const active = document.activeElement;
				if (disabled) focused.current = active instanceof HTMLElement && set.current?.contains(active) ? active : null;
				else if (focused.current && (!active || active === document.body)) {
					focused.current.focus({ preventScroll: true });
					focused.current = null;
				}
			}, [disabled]);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("fieldset", {
				ref: set,
				className: "dt-fieldset",
				disabled,
				children
			});
		}
		function Field({ label, hint, note, action, children }) {
			const id = (0, react.useId)();
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "dt-field",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
						className: "dt-field-head",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
							htmlFor: id,
							children: label
						}), hint && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(InfoTip, { text: hint })]
					}),
					action ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dt-cli-row",
						children: [(0, react.cloneElement)(children, { id }), action]
					}) : (0, react.cloneElement)(children, { id }),
					note && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("small", { children: note })
				]
			});
		}
		function SwitchRow({ label, hint, checked, onChange }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "dt-switch-row",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "dt-field-head",
					children: [label, hint && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(InfoTip, { text: hint })]
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Switch, {
					checked,
					onChange,
					label
				})]
			});
		}
		function ModelField({ id, value, onChange }) {
			const { t, call } = usePanel();
			const [catalog, setCatalog] = (0, react.useState)();
			const [error, setError] = (0, react.useState)();
			(0, react.useEffect)(() => {
				call("GET models").then(setCatalog, (failure) => setError(errorText(failure)));
			}, [call]);
			const current = {
				provider: value?.provider ?? "",
				model: value?.model ?? "",
				effort: value?.reasoningEffort ?? ""
			};
			const set = (next) => {
				const { provider, model, effort } = {
					...current,
					...next
				};
				onChange(provider.trim() || model.trim() || effort.trim() ? {
					provider,
					model,
					...effort ? { reasoningEffort: effort } : {}
				} : null);
			};
			const models = catalog?.groups.find((group) => group.id === current.provider.trim())?.models ?? [];
			const fallback = catalog?.default;
			const input = (name, label, placeholder) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Field, {
				label,
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Input, {
					list: `${id}-${name}s`,
					spellCheck: false,
					placeholder,
					value: current[name],
					onChange: (event) => set({ [name]: event.target.value })
				})
			});
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "dt-model",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Hint, { children: fallback ? t("defaultModel", { model: `${fallback.provider} / ${fallback.model}${fallback.reasoningEffort ? ` · ${fallback.reasoningEffort}` : ""}` }) : t("defaultModelUnavailable") }),
					error && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: "dt-error",
						children: t("modelCatalogError", { error })
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dt-grid3",
						children: [
							input("provider", t("modelProvider"), t("modelInherit")),
							input("model", t("modelName"), t("modelInherit")),
							input("effort", t("modelEffort"), t("modelEffortDefault"))
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("datalist", {
						id: `${id}-providers`,
						children: catalog?.groups.map((group) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
							value: group.id,
							children: group.name
						}, group.id))
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("datalist", {
						id: `${id}-models`,
						children: models.map((model) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
							value: model.id,
							children: model.name
						}, model.id))
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("datalist", {
						id: `${id}-efforts`,
						children: (models.find((model) => model.id === current.model.trim())?.reasoning?.efforts ?? []).map((effort) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
							value: effort.id,
							children: effort.name
						}, effort.id))
					})
				]
			});
		}
		function changeText(t, change, sources) {
			const source = sources.find((item) => item.id === change.source);
			const field = (change.part ? source?.policy?.fields : source?.fields)?.find((item) => item.key === change.field);
			const shown = (value) => value === void 0 || value === null || value === "" ? t("unsetValue") : typeof value === "boolean" ? t(value ? "yes" : "no") : change.code === "mode" ? valueLabel(t, "mode", String(value)) : String(value);
			return t(`change.${change.code}`, {
				items: (change.items ?? []).map((item) => source?.labels[item] ?? item).join(t("listSeparator")),
				from: shown(change.from),
				to: shown(change.to),
				name: change.name ?? "",
				source: source ? localized(t, source.title) : change.source ?? "",
				field: field ? localized(t, field.label) : change.field ?? ""
			});
		}
		/**
		* Collapsible revision history for the specified settings blocks, optionally including all Policy-changing saves.
		* Revisions saved before per-block tracking existed have no `block` and appear under `policy`.
		*/
		/** `except` leaves a block out, for a kind whose settings the panel shows outside the group its block name suggests. */
		function ConfigHistory({ blocks, versions, focus, except = [] }) {
			const { t, call } = usePanel();
			const { settings } = useSettings();
			const { sources } = settings;
			const [open, setOpen] = (0, react.useState)(!!focus);
			const [data, setData] = (0, react.useState)();
			const [error, setError] = (0, react.useState)();
			const revisions = JSON.stringify([Object.values(settings.blocks).map((block) => block.revision), sources.map((source) => source.revision)]);
			(0, react.useEffect)(() => {
				if (open) call("GET policy/history").then(setData, (failure) => setError(errorText(failure)));
			}, [
				open,
				call,
				revisions
			]);
			const listed = (block) => block ? blocks.some((item) => item === block || item.endsWith(":") && block.startsWith(item)) : blocks.includes("policy");
			const items = data?.items.filter((item) => (versions && item.policyChanged || listed(item.block)) && !(item.block && except.includes(item.block))) ?? [];
			const target = focus ? items.filter((item) => item.policyChanged && item.policyVersion.startsWith(focus)).at(-1) : void 0;
			const scroll = (element) => {
				if (element && !element.dataset.scrolled) {
					element.dataset.scrolled = "1";
					element.scrollIntoView?.({ block: "center" });
				}
			};
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(DisclosureRow, {
				icon: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Icon, { name: "history" }),
				title: t("configHistory"),
				open,
				onToggle: () => setOpen(!open),
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "dt-disclosure-body",
					children: [error && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: "dt-error",
						children: error
					}), data && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Hint, { children: t("historyIntro") }),
						focus && !target && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Hint, { children: t("policyVersionUnrecorded", { version: focus.slice(0, 8) }) }),
						items.length ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("ul", {
							className: "dt-timeline",
							children: items.map((item) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", {
								className: item === target ? "dt-event dt-highlight" : "dt-event",
								ref: item === target ? scroll : void 0,
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
										className: "dt-row-title",
										children: t("historyItem", {
											revision: item.revision,
											source: valueLabel(t, "historySource", item.source)
										})
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: "dt-event-foot",
										children: [when(item.savedAt, t("lang")), item.policyChanged && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [" · ", t("historyPolicyChanged", { version: item.policyVersion.slice(0, 8) })] })]
									}),
									item.changes === null ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Hint, { children: t("historyNoBaseline") }) : item.changes.length ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("ul", {
										className: "dt-changes",
										children: item.changes.map((change, index) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("li", { children: changeText(t, change, sources) }, index))
									}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Hint, { children: t("historyNoChanges") }),
									item.notified.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Hint, { children: t("historyNotified", {
										count: item.notified.length,
										titles: item.notified.map((ticket) => ticket.title).join(t("listSeparator"))
									}) })
								]
							}, item.revision))
						}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Hint, { children: t("historyEmpty") })
					] })]
				})
			});
		}
		const ROWS_SHOWN = 6;
		const byName = ([, a], [, b]) => a.localeCompare(b);
		function RowsField({ field, value, saved, onChange, labels, refreshLabels }) {
			const { t, notify } = usePanel();
			const [open, setOpen] = (0, react.useState)(false);
			const refresh = useAction(async () => {
				try {
					const added = await refreshLabels();
					notify(added.length ? t("labelsAdded", { names: added.join(t("listSeparator")) }) : t("labelsCurrent"));
				} catch (failure) {
					notify(t("labelsFailed", { error: errorText(failure) }));
				}
			});
			const label = localized(t, field.label), hint = localized(t, field.hint);
			const rows = Array.isArray(value) ? value : [];
			const set = (index, row) => onChange(rows.map((item, position) => position === index ? row : item));
			const key = field.columns[0];
			const savedKeys = new Set((Array.isArray(saved) ? saved : []).map((row) => row[key.key]));
			const choose = key.type === "text" && key.choose && Object.keys(labels).length ? localized(t, key.choose) : "";
			const choices = (id) => Object.entries(labels).filter(([option]) => option === id || !rows.some((other) => other[key.key] === option)).sort(byName);
			const blank = Object.fromEntries(field.columns.map((column) => [column.key, column.type === "select" ? column.options[0].value : ""]));
			const named = field.columns[1]?.type === "text" ? field.columns[1] : void 0;
			const rowName = (row) => named && row[named.key] || labels[row[key.key] ?? ""] || row[key.key] || "";
			const cell = (row, index, column) => {
				const id = row[key.key] ?? "", change = (next) => set(index, {
					...row,
					[column.key]: next
				});
				if (column === key && (savedKeys.has(id) || !choose && labels[id])) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: labels[id] ? "dt-row-label" : "dt-row-label dt-mono",
					title: id,
					children: labels[id] ?? id
				}, column.key);
				if (column === key && choose) return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
					className: "dt-select",
					"aria-label": choose,
					required: true,
					value: id,
					onChange: (event) => change(event.target.value),
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
						value: "",
						disabled: true,
						children: choose
					}), choices(id).map(([option, name]) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
						value: option,
						children: name
					}, option))]
				}, column.key);
				if (column.type === "text" && column.chooseFrom) {
					const prefix = column.chooseFrom + ":";
					const current = String(row[column.key] ?? "");
					return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
						className: "dt-select",
						"aria-label": localized(t, column.label),
						value: current,
						onChange: (event) => change(event.target.value),
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
								value: "",
								children: localized(t, column.label)
							}),
							current && !labels[prefix + current] ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
								value: current,
								children: current
							}) : null,
							Object.entries(labels).filter(([option]) => option.startsWith(prefix)).sort(byName).map(([option, name]) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
								value: option.slice(prefix.length),
								children: name
							}, option))
						]
					}, column.key);
				}
				if (column.type === "select") return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("select", {
					className: "dt-select",
					"aria-label": localized(t, column.label),
					value: row[column.key] ?? "",
					onChange: (event) => change(event.target.value),
					children: column.options.map((option) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
						value: option.value,
						children: localized(t, option.label)
					}, option.value))
				}, column.key);
				return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Input, {
					className: column.optional ? void 0 : "dt-mono",
					"aria-label": localized(t, column.label),
					placeholder: localized(t, column.label),
					required: !column.optional,
					pattern: column.pattern,
					spellCheck: false,
					value: row[column.key] ?? "",
					onChange: (event) => change(event.target.value)
				}, column.key);
			};
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "dt-field",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dt-subhead",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							className: "dt-field-head",
							children: [
								label,
								hint && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(InfoTip, { text: hint }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "dt-count",
									children: rows.length || ""
								})
							]
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							className: "dt-subhead-actions",
							children: [key.type === "text" && key.refresh && refreshLabels && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Button, {
								variant: "ghost",
								size: "sm",
								className: refresh.busy ? "dt-btn-busy" : void 0,
								icon: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Icon, { name: "refresh" }),
								disabled: refresh.busy,
								"aria-busy": refresh.busy,
								onClick: () => {
									refresh.run();
								},
								children: localized(t, key.refresh)
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Button, {
								variant: "ghost",
								size: "sm",
								icon: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Icon, { name: "plus" }),
								onClick: () => {
									setOpen(true);
									onChange([...rows, blank]);
								},
								children: t("addRow")
							})]
						})]
					}),
					rows.length > ROWS_SHOWN && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						className: "dt-textlink dt-rows-summary",
						"aria-expanded": open,
						onClick: () => setOpen(!open),
						children: open ? t("collapse") : rows.map(rowName).join(t("listSeparator"))
					}),
					(rows.length <= ROWS_SHOWN || open) && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("ul", {
						className: "dt-rows",
						children: rows.map((row, index) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", {
							className: "dt-rows-item",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "dt-rows-head",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "dt-rows-title",
									title: rowName(row) || `#${index + 1}`,
									children: rowName(row) || `#${index + 1}`
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Button, {
									variant: "ghost",
									size: "sm",
									icon: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Icon, { name: "trash" }),
									"aria-label": t("removeRow", { name: labels[row[key.key] ?? ""] || row[key.key] || label }),
									onClick: () => onChange(rows.filter((_, position) => position !== index))
								})]
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "dt-rows-grid",
								children: field.columns.map((column) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
									className: "dt-rows-cell",
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: "dt-rows-cell-label",
										children: localized(t, column.label)
									}), cell(row, index, column)]
								}, column.key))
							})]
						}, index))
					})
				]
			});
		}
		function SourceField({ field, value, saved, fact, onChange, labels, refreshLabels, action, detail }) {
			const { t, navigate } = usePanel();
			const label = localized(t, field.label), hint = localized(t, field.hint);
			switch (field.type) {
				case "switch": return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(SwitchRow, {
					label,
					hint,
					checked: value === true,
					onChange
				});
				case "select": return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Field, {
					label,
					hint,
					children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(SegmentedControl, {
						className: "dt-segmented dt-field-segmented",
						label,
						value: String(value ?? field.options[0].value),
						options: field.options.map((option) => ({
							value: option.value,
							label: localized(t, option.label)
						})),
						onChange
					})
				});
				case "number": return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Field, {
					label,
					hint,
					children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Input, {
						type: "number",
						min: field.min,
						max: field.max,
						required: true,
						value: String(value ?? ""),
						onChange: (event) => onChange(event.target.value === "" ? "" : Number(event.target.value))
					})
				});
				case "text": {
					const selected = String(value ?? "") || String(field.defaultValue ?? "");
					return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Field, {
						label,
						hint,
						note: localized(t, fact),
						action,
						children: field.chooseFrom ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
							className: "dt-select",
							value: selected,
							onChange: (event) => onChange(event.target.value),
							children: [
								!field.noEmptyOption && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
									value: "",
									children: field.choose ? localized(t, field.choose) : localized(t, field.label)
								}),
								selected && !labels[`${field.chooseFrom}:${selected}`] ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
									value: selected,
									children: selected
								}) : null,
								Object.entries(labels).filter(([option]) => option.startsWith(field.chooseFrom + ":")).sort(byName).map(([option, name]) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
									value: option.slice(field.chooseFrom.length + 1),
									children: name
								}, option))
							]
						}) : field.choose && Object.keys(labels).length ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
							className: "dt-select",
							value: String(value ?? ""),
							onChange: (event) => onChange(event.target.value),
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
									value: "",
									children: localized(t, field.choose)
								}),
								value && !labels[String(value)] ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
									value: String(value),
									children: String(value)
								}) : null,
								Object.entries(labels).sort(byName).map(([option, name]) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
									value: option,
									children: name
								}, option))
							]
						}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Input, {
							value: String(value ?? ""),
							readOnly: field.readonly,
							pattern: field.pattern,
							spellCheck: false,
							onChange: (event) => onChange(event.target.value)
						})
					}), detail] });
				}
				case "fact": return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "dt-field",
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							className: "dt-field-head",
							children: [label, hint && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(InfoTip, { text: hint })]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "dt-mono",
							children: localized(t, fact) || t("empty")
						}),
						field.settings && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("small", { children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: "dt-textlink",
							onClick: () => navigate(settingsRoute(field.settings)),
							children: t(`openSettingsOf.${field.settings}`)
						}) })
					]
				});
				case "rows": return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(RowsField, {
					field,
					value,
					saved,
					onChange,
					labels,
					refreshLabels
				});
			}
		}
		//#endregion
		//#region src/client/eval.tsx
		/** Eval status view (Decision log) and Eval settings group (Policy rules, per-Source admission, and assessor settings). */
		function EvalStatus({ filter, window, paused }) {
			const { t, call, navigate } = usePanel();
			const [limit, setLimit] = (0, react.useState)(30);
			const { data, error } = usePoll(() => call("GET decisions", { query: {
				limit,
				kind: DECISION_KINDS[filter],
				...window ? { window } : {}
			} }), [
				filter,
				limit,
				window
			]);
			const show = (key, last24h) => navigate({
				page: "eval",
				query: {
					...key === "work" ? {} : { filter: key },
					...last24h ? { window: "24h" } : {}
				}
			}, true);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)(StatusHead, {
					hint: t("evalStatusIntro"),
					settings: "eval"
				}),
				paused && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
					className: "dt-banner",
					children: [
						t("evalRecordsPaused"),
						" ",
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: "dt-textlink",
							onClick: () => navigate({ page: "execution" }),
							children: t("resumeWhere")
						})
					]
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "dt-filters",
					children: [DECISION_FILTERS.map((key) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Pill, {
						active: filter === key,
						onClick: () => {
							setLimit(30);
							show(key, !!window);
						},
						children: t(`decisionFilter.${key}`)
					}, key)), window && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: "dt-filter-gap" }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Pill, {
						active: true,
						onClick: () => show(filter, false),
						children: t("lastDayOnly")
					})] })]
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)(LoadState, {
					error,
					loading: !data
				}),
				data && (data.items.length ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("ul", {
					className: "dt-list",
					children: data.items.map((decision) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(DecisionLine, { decision }, decision.id))
				}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Hint, { children: t("none") })),
				data?.next_offset != null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(LoadMore, { onMore: () => setLimit(limit + 30) })
			] });
		}
		function RuleRow({ rule, expanded, onToggle, onChange, onDuplicate, onRemove }) {
			const { t } = usePanel();
			const name = rule.name.trim() || t("newRule");
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", {
				className: "dt-rule",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(DisclosureRow, {
					icon: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "dt-rule-dot",
						"data-enabled": rule.enabled || void 0
					}),
					title: name,
					open: expanded,
					onToggle,
					collapsedContent: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "dt-rule-preview",
						children: rule.instruction
					}),
					children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dt-rule-body",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Field, {
								label: t("ruleName"),
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Input, {
									value: rule.name,
									required: true,
									maxLength: LIMITS.ruleName,
									onChange: (event) => onChange({
										...rule,
										name: event.target.value
									})
								})
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Field, {
								label: t("ruleInstruction"),
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("textarea", {
									className: "dt-textarea",
									rows: 4,
									required: true,
									maxLength: LIMITS.ruleInstruction,
									value: rule.instruction,
									placeholder: t("ruleInstructionPlaceholder"),
									onChange: (event) => onChange({
										...rule,
										instruction: event.target.value
									})
								})
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "dt-actions",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Button, {
									variant: "ghost",
									size: "sm",
									icon: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Icon, { name: "copy" }),
									onClick: onDuplicate,
									children: t("duplicate")
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Button, {
									variant: "ghost",
									size: "sm",
									icon: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Icon, { name: "trash" }),
									onClick: onRemove,
									children: t("remove")
								})]
							})
						]
					})
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Switch, {
					className: "dt-rule-switch",
					checked: rule.enabled,
					onChange: (enabled) => onChange({
						...rule,
						enabled
					}),
					label: t("ruleEnable", { name })
				})]
			});
		}
		function SourcePart({ source, part, saved, dirty, onChange, reload }) {
			const { t, call, notify } = usePanel();
			const policy = source.policy;
			const sync = policy.sync;
			const run = useAction(() => call("POST policy-sync/:id", { id: source.id }), { reload });
			const syncNow = () => {
				if (dirty) notify(t("syncNeedsSave"));
				else run.run();
			};
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "dt-part",
				children: [
					policy.fields.map((field) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(SourceField, {
						field,
						value: part[field.key],
						saved: saved[field.key],
						fact: void 0,
						labels: source.labels,
						onChange: (next) => onChange({
							...part,
							[field.key]: next
						})
					}, field.key)),
					sync && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dt-row-buttons",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Button, {
								variant: "outline",
								size: "sm",
								icon: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Icon, { name: "refresh" }),
								disabled: run.busy || !sync.ready,
								onClick: syncNow,
								children: localized(t, sync.label)
							}),
							sync.health?.state === "ready" && sync.health.at && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(LabelValue, {
								label: t("syncDone"),
								value: when(sync.health.at, t("lang"))
							}),
							sync.health?.state === "error" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "dt-error dt-clamp",
								children: sync.health.detail
							})
						]
					}),
					policy.rows ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(AdmissionTable, {
						rows: policy.rows,
						labels: source.labels,
						table: part.admission ?? {},
						explicit: localized(t, policy.explicit),
						onChange: (admission) => onChange({
							...part,
							admission
						})
					}) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dt-field",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "dt-field-head",
							children: t("explicitRequest")
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: localized(t, policy.explicit) })]
					})
				]
			});
		}
		const CELLS = [
			"listedUnaddressed",
			"unlistedAddressed",
			"unlistedUnaddressed"
		];
		function AdmissionTable({ rows, labels, table, explicit, onChange }) {
			const { t } = usePanel();
			const name = (row) => labels[row.id] ?? localized(t, row.label);
			const set = (row, cell, value) => onChange({
				...table,
				[row]: {
					...table[row],
					[cell]: value
				}
			});
			const select = (row, cell) => {
				const value = table[row.id]?.[cell] ?? ADMISSION_DEFAULTS[cell];
				return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", { children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
					className: "dt-admission-cell",
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("select", {
						className: "dt-select",
						"aria-label": `${name(row)} · ${t(`admissionCell.${cell}`)}`,
						value,
						onChange: (event) => set(row.id, cell, event.target.value),
						children: ADMISSION_OPTIONS[cell].map((option) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
							value: option,
							children: t(`admissionValue.${option}`)
						}, option))
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "dt-admission-slot",
						children: cell === "unlistedAddressed" && value === "explicit" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(InfoTip, {
							text: t("admissionAnyoneWarning"),
							icon: "alert",
							warn: true
						})
					})]
				}) }, cell);
			};
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(Section, {
				title: t("admission"),
				hint: t("admissionHint"),
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Hint, { children: explicit }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("table", {
						className: "dt-table dt-admission",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("thead", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("tr", { children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", {
								rowSpan: 2,
								children: t("admissionScope")
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", { children: t("admissionListed") }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", {
								colSpan: 2,
								children: t("admissionUnlisted")
							})
						] }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("tr", { children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", { children: t("admissionUnaddressed") }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", { children: t("admissionAddressed") }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", { children: t("admissionUnaddressed") })
						] })] }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("tbody", { children: rows.map((row) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("tr", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("td", {
							className: "dt-admission-scope",
							children: [name(row), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("small", { children: localized(t, row.note) })]
						}), CELLS.map((cell) => row.cells[cell] ? select(row, cell) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
							className: "dt-admission-na",
							"aria-label": t("admissionNotReceived"),
							children: "—"
						}, cell))] }, row.id)) })]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Hint, { children: t("admissionFootnote") })
				]
			});
		}
		function PolicyBlock() {
			const { t } = usePanel();
			const { settings: { blocks, sources, policyVersion }, reload } = useSettings();
			const draft = useBlockDraft("policy", blocks.policy.value, blocks.policy.revision);
			const policy = draft.value;
			const [expanded, setExpanded] = (0, react.useState)(/* @__PURE__ */ new Set());
			const parts = sources.filter((source) => source.installed && source.policy);
			const [tab, setTab] = (0, react.useState)();
			const current = parts.find((source) => source.id === tab) ?? parts[0];
			const edit = (next) => draft.edit({
				...policy,
				...next
			});
			const toggle = (id) => {
				const next = new Set(expanded);
				if (next.has(id)) next.delete(id);
				else next.add(id);
				setExpanded(next);
			};
			const insert = (rule, at) => {
				setExpanded(/* @__PURE__ */ new Set([...expanded, rule.id]));
				edit({ rules: [
					...policy.rules.slice(0, at),
					rule,
					...policy.rules.slice(at)
				] });
			};
			const reveal = (target) => {
				if (target instanceof Element && target.closest(".dt-rules")) setExpanded(new Set(policy.rules.map((rule) => rule.id)));
			};
			const part = (id) => policy.sources[id] ?? { allowed: [] };
			const add = () => insert({
				id: crypto.randomUUID(),
				name: "",
				enabled: true,
				instruction: ""
			}, policy.rules.length);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("form", {
				className: "dt-form dt-block",
				onSubmit: (event) => {
					draft.submit(event);
				},
				onInvalidCapture: (event) => reveal(event.target),
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)(Fields, {
					disabled: draft.busy,
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("h2", {
							className: "dt-block-title",
							children: [t("term.policy"), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(InfoTip, { text: t("policyIntro") })]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
							className: "dt-flow",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(LabelValue, {
								label: t("policyVersion"),
								value: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "dt-mono",
									children: policyVersion.slice(0, 8)
								})
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(InfoTip, { text: t("policyVersionHint") })]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Section, {
							title: t("rules"),
							hint: t("rulesHint"),
							action: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Button, {
								variant: "ghost",
								size: "sm",
								icon: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Icon, { name: "plus" }),
								onClick: add,
								children: t("addRule")
							}),
							children: policy.rules.length ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("ul", {
								className: "dt-rules",
								children: policy.rules.map((rule, index) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(RuleRow, {
									rule,
									expanded: expanded.has(rule.id),
									onToggle: () => toggle(rule.id),
									onChange: (next) => edit({ rules: policy.rules.map((item, position) => position === index ? next : item) }),
									onDuplicate: () => insert({
										...rule,
										id: crypto.randomUUID(),
										name: `${rule.name}${t("copySuffix")}`.slice(0, LIMITS.ruleName)
									}, index + 1),
									onRemove: () => edit({ rules: policy.rules.filter((_, position) => position !== index) })
								}, rule.id))
							}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Hint, { children: t("rulesEmpty") })
						}),
						current && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(Section, {
							title: t("policyPerSource"),
							hint: t("policyPerSourceHint"),
							children: [parts.length > 1 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "dt-subtabs",
								role: "tablist",
								"aria-label": t("policyPerSource"),
								children: parts.map((source) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									role: "tab",
									"aria-selected": source === current,
									className: "dt-subtab",
									onClick: () => setTab(source.id),
									children: localized(t, source.title)
								}, source.id))
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(SourcePart, {
								source: current,
								part: part(current.id),
								saved: blocks.policy.value.sources[current.id] ?? {},
								dirty: draft.dirty,
								reload,
								onChange: (next) => edit({ sources: {
									...policy.sources,
									[current.id]: next
								} })
							}, current.id)]
						})
					]
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(SaveBar, {
					...draft,
					onDiscard: draft.discard
				})]
			});
		}
		function EvalBlock() {
			const { t } = usePanel();
			const block = useSettings().settings.blocks.eval;
			const draft = useBlockDraft("eval", {
				...block.value,
				timeoutSeconds: String(block.value.timeoutSeconds)
			}, block.revision, (value) => ({
				...value,
				timeoutSeconds: numberOf(value.timeoutSeconds)
			}));
			const value = draft.value;
			const edit = (next) => draft.edit({
				...value,
				...next
			});
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("form", {
				className: "dt-form dt-block",
				onSubmit: (event) => {
					draft.submit(event);
				},
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)(Fields, {
					disabled: draft.busy,
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("h2", {
							className: "dt-block-title",
							children: [t("evalSettings"), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(InfoTip, { text: t("evalIntro") })]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Section, {
							title: t("acceptMode"),
							hint: t(`modeOption.${value.mode}`),
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(SegmentedControl, {
								className: "dt-segmented",
								label: t("acceptMode"),
								value: value.mode,
								onChange: (mode) => edit({ mode }),
								options: [
									"off",
									"observe",
									"auto"
								].map((mode) => ({
									value: mode,
									label: valueLabel(t, "mode", mode),
									title: t(`modeOption.${mode}`)
								}))
							})
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Field, {
							label: t("evalTimeout"),
							hint: t("evalTimeoutHint"),
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Input, {
								type: "number",
								min: LIMITS.evalTimeoutSeconds.min,
								max: LIMITS.evalTimeoutSeconds.max,
								required: true,
								value: value.timeoutSeconds,
								onChange: (event) => edit({ timeoutSeconds: event.target.value })
							})
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Section, {
							title: t("assessorModel"),
							hint: t("assessorModelHint"),
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ModelField, {
								id: "dt-eval-model",
								value: value.model,
								onChange: (model) => edit({ model })
							})
						})
					]
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(SaveBar, {
					...draft,
					onDiscard: draft.discard
				})]
			});
		}
		function EvalSettings({ version }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "dt-form",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(PolicyBlock, {}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(EvalBlock, {}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(ConfigHistory, {
						blocks: ["policy", "eval"],
						versions: true,
						...version ? { focus: version } : {}
					})
				]
			});
		}
		//#endregion
		//#region src/client/group-runs.tsx
		/**
		* VsSaros addition (2026-11-05): live group-chat runs in the Workbench and Execution tabs.
		*
		* The orchestrator's `GET state` / `GET tickets` / `GET team/steps` only describe Tickets, Steps and Executor slots.
		* A group chat relay lives in `vssaros-agents` and is broadcast by `vssaros-chat-surface`'s global activity dock as
		* `vssaros-group-progress`. This module is read-only: it does not change Ticket/Step semantics, SSE topics or host APIs.
		*/
		const GROUP_PROGRESS_EVENT = "vssaros-group-progress";
		const STATUSES = [
			"sent",
			"replying",
			"done",
			"cut",
			"failed"
		];
		/**
		* The one state machine for a group run (verbatim copy of vssaros-agents `roundStatusOf`; the server's `status` wins).
		* Interrupted beats failed: a run cut by a restart carries an error too. check-bots-rooms.mjs pins all copies to one table.
		*/
		function groupRoundStatus(run) {
			const r = run && typeof run === "object" ? run : {};
			if (r.status && STATUSES.includes(r.status)) return r.status;
			const events = Array.isArray(r.events) ? r.events : [];
			if (r.interrupted || r.phase === "cut" || events.some((event) => event && event.kind === "cut")) return "cut";
			if (!r.done) return (Array.isArray(r.speaking) ? r.speaking.length : 0) > 0 ? "replying" : "sent";
			return r.error ? "failed" : "done";
		}
		/** Drops malformed entries of a broadcast this panel does not own. */
		function normalizeGroupRuns(value) {
			return (Array.isArray(value) ? value : []).filter((item) => !!item && typeof item === "object" && typeof item.roomId === "string" && !!item.roomId);
		}
		/** Initial snapshot left by the chat-surface activity dock; the event below keeps it current. */
		function globalRuns() {
			if (typeof window === "undefined") return [];
			return normalizeGroupRuns(window.__vssarosGroupProgress);
		}
		/** The Bots plugin's list of running and recently ended group runs (what the chat-surface dock broadcasts). */
		const AGENTS_ROOMS_ACTIVE = "/x/agents/api/rooms?active=1";
		/**
		* How long to wait for a broadcast before reading the list directly, and how often then. Without it the section stayed empty
		* whenever chat-surface was missing, loaded later, or ran in another webview. Tests may shorten it.
		*/
		const groupRunsConfig = { fallbackMs: 5e3 };
		/**
		* One subscription per mounted tab. The chat-surface broadcast is the source; only while none has been heard does the tab
		* read the list itself, slowly, and it stops as soon as a broadcast arrives. No host API or SSE topic changes.
		*/
		function useGroupRuns() {
			const [runs, setRuns] = (0, react.useState)(globalRuns);
			(0, react.useEffect)(() => {
				if (typeof window === "undefined") return;
				let alive = true;
				let heard = Array.isArray(window.__vssarosGroupProgress);
				let timer;
				setRuns(globalRuns());
				const onProgress = (event) => {
					heard = true;
					const detail = event.detail;
					setRuns(normalizeGroupRuns(detail?.active));
				};
				const poll = async () => {
					if (!alive || heard) return;
					try {
						const response = await fetch(AGENTS_ROOMS_ACTIVE);
						const body = response.ok ? await response.json() : void 0;
						if (alive && !heard && Array.isArray(body?.active)) setRuns(normalizeGroupRuns(body.active));
					} catch {}
					if (alive && !heard) timer = setTimeout(() => {
						poll();
					}, groupRunsConfig.fallbackMs);
				};
				window.addEventListener(GROUP_PROGRESS_EVENT, onProgress);
				if (!heard) timer = setTimeout(() => {
					poll();
				}, groupRunsConfig.fallbackMs);
				return () => {
					alive = false;
					clearTimeout(timer);
					window.removeEventListener(GROUP_PROGRESS_EVENT, onProgress);
				};
			}, []);
			return runs;
		}
		function groupRunState(run) {
			const status = groupRoundStatus(run);
			return status === "failed" ? "error" : status === "cut" ? "cut" : status === "done" ? "done" : "running";
		}
		function groupRunStatusKey(run) {
			const status = groupRoundStatus(run);
			return status === "failed" ? "groupRuns.status.error" : status === "cut" ? "groupRuns.status.cut" : status === "done" ? "groupRuns.status.done" : status === "replying" ? "groupRuns.status.replying" : "groupRuns.status.running";
		}
		function groupRunReplies(run) {
			return (Array.isArray(run?.replies) ? run.replies : []).filter((reply) => reply && !reply.kind);
		}
		function groupRunElapsed(run, now = Date.now()) {
			const started = Number(run?.startedAt ?? 0);
			if (!started) return 0;
			const ended = Number(run?.finishedAt ?? 0) || now;
			return Math.max(0, Math.round((ended - started) / 1e3));
		}
		function groupRunLatestEvent(run) {
			const events = Array.isArray(run?.events) ? run.events : [];
			return events.length ? events[events.length - 1] : void 0;
		}
		const memberLabelKey = (state) => state === "speaking" ? "groupRuns.member.speaking" : state === "replied" ? "groupRuns.member.replied" : state === "passed" ? "groupRuns.member.passed" : state === "failed" ? "groupRuns.member.failed" : "groupRuns.member.waiting";
		/** Merge name-only `speaking/passed/events` with `replies/failed`, first state wins. */
		function groupRunMembers(run) {
			const out = [];
			const add = (value, state) => {
				const name = String(value ?? "").trim();
				if (!name || out.some((item) => item.name === name)) return;
				out.push({
					name,
					state,
					labelKey: memberLabelKey(state)
				});
			};
			for (const item of Array.isArray(run?.failed) ? run.failed : []) add(item?.name, "failed");
			for (const event of Array.isArray(run?.events) ? run.events : []) if (event?.name && /^(failed|missed|cut)$/.test(String(event.kind ?? ""))) add(event.name, "failed");
			for (const name of Array.isArray(run?.speaking) ? run.speaking : []) add(name, "speaking");
			for (const event of Array.isArray(run?.events) ? run.events : []) {
				if (!event?.name) continue;
				add(event.name, /^(working|resumed)$/.test(String(event.kind ?? "")) ? "speaking" : "waiting");
			}
			for (const reply of groupRunReplies(run)) add(reply?.name, "replied");
			for (const name of Array.isArray(run?.passed) ? run.passed : []) add(name, "passed");
			return out;
		}
		/** Where a run came from: an `@group` routed from another conversation, or the request that created the group. */
		function groupRunSource(run) {
			if (run?.fromSession) return "post";
			if (run?.originTriggerId) return "created";
		}
		/**
		* The run a desk message's card follows. An `@group` command follows the run its own message started (the agents plugin
		* records the DSH message id as `sourceMessageId`), never another one in the same group; a new group follows its latest run.
		*/
		function groupRunForFlow(runs, group) {
			const inRoom = (runs ?? []).filter((run) => run?.roomId === group.roomId);
			if (group.kind === "routed") return group.sourceMessageId ? inRoom.find((run) => run.sourceMessageId === group.sourceMessageId) : void 0;
			return [...inRoom].sort((a, b) => Number(b.startedAt ?? 0) - Number(a.startedAt ?? 0))[0];
		}
		/** Independent section; deliberately avoids `.dt-status-line`, `.dt-lv`, `.dt-stat`, `.dt-work-bar` and the ticket list. */
		function GroupRuns({ compact = false }) {
			const { t, openSession, notify } = usePanel();
			const runs = useGroupRuns();
			if (!runs.length) return null;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
				className: "dt-group-runs",
				"data-vssaros-group-runs": "1",
				"data-testid": "group-runs",
				"aria-label": t("groupRuns.title"),
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dt-group-runs-head",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("b", { children: t("groupRuns.title") }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: runs.length })]
					}),
					compact && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: "dt-group-runs-note",
						"data-testid": "group-runs-note",
						children: t("groupRuns.note")
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "dt-group-runs-list",
						children: runs.slice(0, compact ? 3 : 5).map((run, index) => {
							const state = groupRunState(run);
							const statusKey = groupRunStatusKey(run);
							const replies = groupRunReplies(run);
							const members = groupRunMembers(run);
							const latest = groupRunLatestEvent(run);
							const roomName = String(run?.roomName || run?.roomId || "群聊");
							const failures = Array.isArray(run?.failed) ? run.failed.length : 0;
							const source = groupRunSource(run);
							const roomId = String(run?.roomId || "");
							return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("article", {
								className: "dt-group-runs-card",
								"data-vssaros-group-run": String(run?.callId || ""),
								"data-vssaros-group-run-room": roomId,
								"data-vssaros-group-run-state": state,
								"data-vssaros-group-run-status": t(statusKey),
								"data-vssaros-group-run-round-status": groupRoundStatus(run),
								"data-vssaros-group-run-source": source ?? "",
								"data-vssaros-group-run-trigger": String(run?.originTriggerId || ""),
								"data-vssaros-group-run-name": roomName,
								"data-vssaros-group-run-replies": String(replies.length),
								"data-vssaros-group-run-elapsed": String(groupRunElapsed(run)),
								"data-state": state,
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: "dt-group-runs-title",
										children: [
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												className: "dt-group-runs-dot",
												"data-state": state,
												"aria-hidden": "true"
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("b", { children: roomName }),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												className: "dt-group-runs-status",
												children: t(statusKey)
											}),
											roomId && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
												type: "button",
												className: "dt-textlink dt-group-runs-open",
												"data-act": "open-group-run",
												onClick: () => {
													openSession(roomId).catch((failure) => notify(errorText(failure)));
												},
												children: t("groupRuns.open")
											})
										]
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: "dt-group-runs-meta",
										children: [
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("groupRuns.replies", { n: String(replies.length) }) }),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("groupRuns.elapsed", { n: String(groupRunElapsed(run)) }) }),
											failures > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("groupRuns.failed", { n: String(failures) }) }),
											source && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												className: "dt-group-runs-source",
												title: run?.originTriggerId ? t("groupRuns.source.trigger", { id: run.originTriggerId }) : void 0,
												children: t(source === "post" ? "groupRuns.source.post" : "groupRuns.source.created")
											})
										]
									}),
									members.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
										className: "dt-group-runs-members",
										children: members.slice(0, 8).map((member) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
											className: "dt-group-runs-member",
											"data-vssaros-group-run-member": member.name,
											"data-vssaros-group-run-member-state": member.state,
											title: `${member.name} · ${t(member.labelKey)}`,
											children: [
												member.name,
												" · ",
												t(member.labelKey)
											]
										}, member.name))
									}),
									latest?.text && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
										className: "dt-group-runs-latest",
										children: String(latest.text).slice(0, 120)
									})
								]
							}, String(run?.callId || run?.roomId || index));
						})
					})
				]
			});
		}
		//#endregion
		//#region src/client/usage.tsx
		/**
		* VsSaros addition (2026-11-06, P2): on the execution page, what SuperAgent's Sessions used (the usage ledger, with the
		* context steward's last work), and the approval rules a person gave team Bots, with the templates to give more at once.
		*/
		const ROLES = [
			"master",
			"desk",
			"worker",
			"step"
		];
		const tokens = (value) => value >= 1e4 ? `${(value / 1e3).toFixed(value >= 1e5 ? 0 : 1)}k` : String(value);
		function UsagePanel() {
			const { t, call } = usePanel();
			const [open, setOpen] = (0, react.useState)(false);
			const { data } = usePoll(() => call("GET usage"), []);
			const usage = data;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(DisclosureRow, {
				icon: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Icon, { name: "clock" }),
				title: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
					t("usageTitle"),
					" ",
					usage && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "dt-count",
						children: tokens(usage.day.total.total)
					})
				] }),
				open,
				onToggle: () => setOpen(!open),
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "dt-disclosure-body",
					"data-testid": "usage-panel",
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Hint, { children: t("usageHint") }), usage && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "dt-row-meta",
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("usageDay", {
									total: tokens(usage.day.total.total),
									calls: String(usage.day.total.calls)
								}) }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("usageWeek", { total: tokens(usage.week.total) }) }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("usageCache", { read: tokens(usage.day.total.cacheRead) }) })
							]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("ul", {
							className: "dt-list",
							children: ROLES.map((role) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("li", {
								className: "dt-row",
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: "dt-row-main",
									children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: "dt-row-meta",
										children: [
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t(`usageRole.${role}`) }),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: tokens(usage.day.byRole[role]?.total ?? 0) }),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("usageCalls", { calls: String(usage.day.byRole[role]?.calls ?? 0) }) })
										]
									})
								})
							}, role))
						}),
						usage.day.byModel.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: "dt-row-meta",
							children: usage.day.byModel.slice(0, 5).map((item) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								className: "dt-mono",
								children: [
									item.model || item.provider,
									": ",
									tokens(item.total)
								]
							}, `${item.provider}/${item.model}`))
						}),
						usage.day.byBot.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: "dt-row-meta",
							children: usage.day.byBot.slice(0, 5).map((item) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: [
								item.bot,
								": ",
								tokens(item.total)
							] }, item.bot))
						}),
						usage.steward.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: "dt-row-meta",
							"data-testid": "steward",
							children: usage.steward.map((item) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: [
								t(`usageRole.${item.role}`),
								t("listSeparator"),
								t(`steward.${item.outcome}`, {
									context: tokens(item.context ?? 0),
									line: tokens(item.line ?? 0)
								})
							] }, item.session))
						}),
						usage.day.relays.resent + usage.day.relays.side > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "dt-hint",
							"data-testid": "usage-relays",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", { children: [t(usage.coexist.dsBot ? "usageRelaysDsBot" : "usageRelaysOther", {
								resent: String(usage.day.relays.resent),
								side: String(usage.day.relays.side)
							}), !usage.sideCalls && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [" ", t("sideCallsOff")] })] }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("ul", {
								className: "dt-list",
								children: usage.day.relays.sessions.slice(0, 5).map((item) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", {
									className: "dt-row-meta",
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: [t(`usageRole.${item.role}`), item.step ? ` · ${item.step}` : ""] }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("usageRelaySession", {
										resent: String(item.resent),
										side: String(item.side)
									}) })]
								}, item.session))
							})]
						})
					] })]
				})
			});
		}
		function ApprovalRulesPanel() {
			const { t, call } = usePanel();
			const [open, setOpen] = (0, react.useState)(false);
			const [bot, setBot] = (0, react.useState)("");
			const { data, reload } = usePoll(() => call("GET steps/rules"), []);
			const { data: bots } = usePoll(() => call("GET team/bots"), []);
			const apply = useAction((template) => {
				const card = bots?.bots.find((item) => item.id === bot);
				return card ? call("POST steps/rules/templates/:id/apply", {
					id: template,
					body: {
						botId: card.id,
						botName: card.name
					}
				}) : Promise.resolve();
			}, { reload });
			const forget = useAction((id) => call("POST steps/rules/:id/delete", { id }), { reload });
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(DisclosureRow, {
				icon: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Icon, { name: "shield" }),
				title: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
					t("rulesTitle"),
					" ",
					data && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "dt-count",
						children: data.rules.length
					})
				] }),
				open,
				onToggle: () => setOpen(!open),
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "dt-disclosure-body",
					"data-testid": "approval-rules",
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Hint, { children: t("rulesTemplateHint") }),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "dt-row-meta",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
								"aria-label": t("rulesBot"),
								value: bot,
								onChange: (event) => {
									setBot(event.target.value);
								},
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
									value: "",
									children: t("rulesBot")
								}), bots?.bots.map((card) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
									value: card.id,
									children: card.name
								}, card.id))]
							}), data?.templates.map((template) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(Button, {
								variant: "outline",
								size: "sm",
								disabled: !bot || apply.busy,
								title: template.heads.join(", "),
								onClick: () => {
									apply.run(template.id);
								},
								children: [t(`rulesTemplate.${template.id}`), template.risk !== "low" ? ` · ${t("rulesRiskMedium")}` : ""]
							}, template.id))]
						}),
						data && (data.rules.length ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("ul", {
							className: "dt-list",
							children: data.rules.map((rule) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("li", {
								className: "dt-row",
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: "dt-row-main",
									children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: "dt-row-meta",
										children: [
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: rule.bot.name }),
											/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
												className: "dt-mono",
												children: [
													rule.tool,
													": ",
													rule.head
												]
											}),
											rule.template && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t(`rulesTemplate.${rule.template}`) }),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
												type: "button",
												className: "dt-textlink",
												disabled: forget.busy,
												onClick: () => {
													forget.run(rule.id);
												},
												children: t("rulesForget")
											})
										]
									})
								})
							}, rule.id))
						}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Hint, { children: t("rulesNone") }))
					]
				})
			});
		}
		//#endregion
		//#region src/client/tapd-credentials.tsx
		/**
		* VsSaros addition: the TAPD setup checklist and Open API credentials on the TAPD Source card.
		*
		* The checklist is data-driven: the Host reports the credential source, saved watch count, resolved identity
		* and the live health code instead of the panel guessing from static hints. The secret itself is written by the
		* Host into its credentials file (`<DSH_HOME>/tapd.env`, or DSH_SUPERAGENT_TAPD_ENV_FILE), never into the
		* settings store; the panel only ever gets a masked account name. The product also ships a TAPD API account.
		*/
		const KINDS = [
			"client",
			"user",
			"token"
		];
		/** Enter in these inputs must not submit the Source card's form, which would save the Source draft instead. */
		const keepEnter = (event) => {
			if (event.key === "Enter") event.preventDefault();
		};
		/** Health codes the panel has a localized sentence for; anything else is shown verbatim. */
		const HEALTH_MESSAGES = [
			"sourceOff",
			"tapdUnset",
			"tapdWebhookUnset"
		];
		/** Two starter watches for the saved project: an empty workspace inherits the card's project ID. */
		function recommendedWatches(agent) {
			const owner = agent.trim();
			return ["bug", "story"].map((type) => ({
				name: type === "bug" ? "bugs" : "stories",
				workspace: "",
				type,
				item: "",
				status: "",
				owner,
				iteration: "",
				mode: owner ? "assigned" : "all"
			}));
		}
		function TapdCredentials({ config, onAddWatch }) {
			const { t, call, notify } = usePanel();
			const [status, setStatus] = (0, react.useState)();
			const [setup, setSetup] = (0, react.useState)();
			const [test, setTest] = (0, react.useState)();
			const [testing, setTesting] = (0, react.useState)(false);
			const [detailsOpen, setDetailsOpen] = (0, react.useState)(false);
			const [customOpen, setCustomOpen] = (0, react.useState)(false);
			const [kind, setKind] = (0, react.useState)("client");
			const [id, setId] = (0, react.useState)("");
			const [secret, setSecret] = (0, react.useState)("");
			const refresh = async () => {
				const [credential, next] = await Promise.all([call("GET sources/tapd/credentials"), call("GET sources/tapd/setup")]);
				setStatus(credential);
				setSetup(next);
				return credential;
			};
			(0, react.useEffect)(() => {
				refresh().then((credential) => {
					if (credential.kind) setKind(credential.kind);
				}).catch(() => {});
			}, []);
			const same = status?.kind === kind && !!status.saved;
			const save = useAction(async () => {
				setStatus(await call("POST sources/tapd/credentials", { body: {
					kind,
					id: id.trim(),
					secret: secret.trim()
				} }));
				setSetup(await call("GET sources/tapd/setup"));
				setId("");
				setSecret("");
				notify(t("tapdCred.saved"));
			});
			const clear = async () => {
				setStatus(await call("POST sources/tapd/credentials", { body: { clear: true } }));
				setSetup(await call("GET sources/tapd/setup"));
				notify(t("tapdCred.cleared"));
			};
			const switchBundled = async (bundled) => {
				setStatus(await call("POST sources/tapd/credentials", { body: { bundled } }));
				setSetup(await call("GET sources/tapd/setup"));
				notify(t("tapdCred.bundledSwitched"));
			};
			const runTest = async () => {
				setTesting(true);
				try {
					setTest(await call("POST sources/tapd/test", { body: {} }));
				} finally {
					setTesting(false);
				}
			};
			const idLabel = kind === "client" ? t("tapdCred.clientId") : t("tapdCred.user");
			const secretLabel = kind === "client" ? t("tapdCred.clientSecret") : kind === "user" ? t("tapdCred.password") : t("tapdCred.token");
			const ready = (kind === "token" || !!id.trim() || same && !!status?.account) && (!!secret.trim() || same) && (!!id.trim() || !!secret.trim());
			const sourceTag = !status ? t("empty") : status.source === "environment" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Tag, {
				tone: "success",
				children: t("tapdCred.fromEnv")
			}) : status.source === "file" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Tag, {
				tone: "success",
				children: t("tapdCred.fromFile")
			}) : status.source === "bundled" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Tag, {
				tone: "success",
				children: t("tapdCred.fromBundled")
			}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Tag, {
				tone: "danger",
				children: t("tapdCred.none")
			});
			const watchTag = !setup ? t("empty") : setup.watches > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Tag, {
				tone: "success",
				children: t("tapdCheck.watchesSome", { count: String(setup.watches) })
			}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Tag, {
				tone: "danger",
				children: t("tapdCheck.watchesNone")
			});
			const identityTag = !setup ? t("empty") : !setup.agent ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Tag, {
				tone: "warning",
				children: t("tapdCheck.identityEmpty")
			}) : setup.agentMapped ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Tag, {
				tone: "success",
				children: t("tapdCheck.identityMapped", { name: setup.agentResolved })
			}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Tag, {
				tone: "warning",
				children: t("tapdCheck.identityUnmapped", { name: setup.agent })
			});
			const healthLabel = (code) => !code ? t("tapdCheck.healthUnknown") : HEALTH_MESSAGES.includes(code) ? t(`healthCode.${code}`) : code;
			const draft = config.watches;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "dt-field",
				"data-tapd-credentials": "",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "dt-field-head",
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", { children: t("tapdCheck.title") })
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(KeyValues, { rows: [
						[t("tapdCheck.credentials"), sourceTag],
						[t("tapdCheck.watches"), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [watchTag, setup && draft !== setup.watches ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							className: "dt-mono",
							children: [" · ", t("tapdCheck.draftSaved", { count: String(draft) })]
						}) : null] })],
						[t("tapdCheck.identity"), identityTag],
						[t("tapdCheck.health"), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "dt-mono",
							children: healthLabel(setup?.healthCode)
						})],
						[t("tapdCheck.connectivity"), !test ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Tag, {
							tone: "neutral",
							children: t("tapdCheck.notTested")
						}) : test.ok ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Tag, {
							tone: "success",
							children: t("tapdCheck.testOk", { method: test.method ?? "" })
						}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Tag, {
							tone: "danger",
							children: t("tapdCheck.testFail", { error: test.error ?? "" })
						})]
					] }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dt-row-buttons",
						children: [setup && setup.watches === 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Button, {
							variant: "outline",
							size: "sm",
							onClick: () => {
								onAddWatch(recommendedWatches(setup.agent));
								notify(t("tapdCheck.watchesAdded"));
							},
							children: t("tapdCheck.watchesAdd")
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Button, {
							variant: "outline",
							size: "sm",
							disabled: testing,
							onClick: () => {
								runTest();
							},
							children: testing ? t("tapdCheck.testing") : t("tapdCheck.test")
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "dt-field-head",
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", { children: t("tapdCred.title") })
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(KeyValues, { rows: [
						[t("tapdCred.status"), sourceTag],
						...status?.method ? [[t("tapdCred.method"), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "dt-mono",
							children: status.source === "bundled" ? `${t("tapdCred.methodBundled")}${status.account ? ` · ${status.account}` : ""}` : status.method
						})]] : [],
						...status?.account ? [[t("tapdCred.account"), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "dt-mono",
							children: status.account
						})]] : [],
						[t("tapdCred.writeTo"), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "dt-mono",
							children: status?.file ?? t("empty")
						})]
					] }),
					status?.overridden && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Hint, { children: t("tapdCred.overridden") }),
					status?.source === "bundled" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Hint, { children: t("tapdCred.bundledHint") }),
					status?.bundled && !status.saved && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Hint, { children: t("tapdCred.overrideHint") }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)(DisclosureRow, {
						icon: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Icon, { name: "settings" }),
						title: t("tapdCred.custom"),
						open: customOpen,
						onToggle: () => setCustomOpen(!customOpen),
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Hint, { children: t("tapdCred.customHint") }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(SegmentedControl, {
								className: "dt-segmented dt-field-segmented",
								label: t("tapdCred.kind"),
								value: kind,
								onChange: setKind,
								options: KINDS.map((value) => ({
									value,
									label: t(`tapdCred.kind.${value}`)
								}))
							}),
							kind !== "token" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Field, {
								label: idLabel,
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Input, {
									value: id,
									autoComplete: "off",
									spellCheck: false,
									onKeyDown: keepEnter,
									onChange: (event) => setId(event.target.value),
									placeholder: same && status?.account ? t("tapdCred.keep", { value: status.account }) : ""
								})
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Field, {
								label: secretLabel,
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Input, {
									type: "password",
									value: secret,
									autoComplete: "new-password",
									onKeyDown: keepEnter,
									onChange: (event) => setSecret(event.target.value),
									placeholder: same ? t("tapdCred.keepSecret") : ""
								})
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Hint, { children: t("tapdCred.hint") }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(DisclosureRow, {
								icon: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Icon, { name: "settings" }),
								title: t("tapdCred.details"),
								open: detailsOpen,
								onToggle: () => setDetailsOpen(!detailsOpen),
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Hint, { children: t("tapdCred.detailsHint") })
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "dt-row-buttons",
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Button, {
									variant: "outline",
									size: "sm",
									disabled: save.busy || !ready,
									onClick: () => {
										save.run();
									},
									children: save.busy ? t("tapdCred.saving") : t("tapdCred.save")
								})
							})
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dt-row-buttons",
						children: [
							status?.saved && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ConfirmButton, {
								label: t("tapdCred.clear"),
								title: t("tapdCred.clearTitle"),
								message: t("tapdCred.clearConfirm", { file: status.file }),
								onConfirm: clear
							}),
							status?.bundled && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ConfirmButton, {
								label: t("tapdCred.bundledOff"),
								title: t("tapdCred.bundledOffTitle"),
								message: t("tapdCred.bundledOffConfirm"),
								onConfirm: () => switchBundled("off")
							}),
							status && !status.bundled && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Button, {
								variant: "outline",
								size: "sm",
								onClick: () => {
									switchBundled("on");
								},
								children: t("tapdCred.bundledOn")
							})
						]
					})
				]
			});
		}
		//#endregion
		//#region src/client/source.tsx
		/** Source status view (health, filtered Triggers, dropped replies) and Source settings cards. */
		/**
		* VsSaros addition: a Source kind's settings card. `title` overrides its heading, for a kind the panel shows somewhere
		* other than the Sources page (P4, which is a way to manage projects rather than a place work arrives from).
		*/
		function SourceCard({ source, title }) {
			const { t, call } = usePanel();
			const { running } = usePanelData();
			const { reload } = useSettings();
			const [advancedOpen, setAdvancedOpen] = (0, react.useState)(false);
			const [feishuAppLabels, setFeishuAppLabels] = (0, react.useState)({});
			(0, react.useEffect)(() => {
				if (source.id !== "feishu" || !source.installed) return;
				let alive = true;
				fetch("/x/agents/api/bindings", {
					credentials: "same-origin",
					headers: { accept: "application/json" }
				}).then((response) => response.ok ? response.json() : { feishuApps: [] }).then((data) => {
					if (!alive) return;
					const options = {};
					for (const app of data.feishuApps ?? []) {
						const id = String(app.appId ?? "").trim();
						if (!id) continue;
						const name = String(app.name ?? "").trim();
						const label = app.isDefault ? "VsSaros助手 · " + id : (name ? name + " · " : "") + id;
						options["feishuApps:" + id] = label + (app.hasSecret ? "" : "（缺 App Secret）");
					}
					setFeishuAppLabels(options);
				}).catch(() => {});
				return () => {
					alive = false;
				};
			}, [source.id, source.installed]);
			const appLabels = {
				...source.labels,
				...feishuAppLabels
			};
			const refreshLabels = async () => {
				const { added } = await call("POST sources/:id/labels", { id: source.id });
				await reload();
				return added;
			};
			(0, react.useEffect)(() => {
				if (source.installed && source.id === "tapd" && !Object.keys(source.labels ?? {}).some((name) => name.includes(":"))) refreshLabels().catch(() => {});
			}, [source.id, source.installed]);
			const draft = useBlockDraft(`source:${source.id}`, source.value, source.revision);
			const value = draft.value;
			const { problem, value: saved } = source;
			const changed = (key) => String(value.config[key] ?? "") !== String(saved.config[key] ?? "");
			const restarts = draft.dirty && source.restarts.some(changed);
			const description = localized(t, source.description);
			const field = (spec) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(SourceField, {
				field: spec,
				value: value.config[spec.key],
				saved: saved.config[spec.key],
				labels: source.id === "feishu" && spec.key === "appId" ? appLabels : source.labels,
				refreshLabels,
				fact: spec.type === "fact" || !changed(spec.key) ? source.facts[spec.key] : void 0,
				onChange: (next) => draft.edit({
					...value,
					config: {
						...value.config,
						[spec.key]: next
					}
				})
			}, spec.key);
			const advanced = source.fields.filter((spec) => spec.advanced);
			const advancedGroups = (() => {
				const groups = /* @__PURE__ */ new Map();
				for (const spec of advanced) {
					const title = spec.group ? localized(t, spec.group) : "";
					if (!groups.has(title)) groups.set(title, {
						title,
						specs: []
					});
					groups.get(title).specs.push(spec);
				}
				return [...groups.values()];
			})();
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("form", {
				id: `dt-source-${source.id}`,
				className: "dt-card",
				onSubmit: (event) => {
					draft.submit(event);
				},
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)(Fields, {
					disabled: draft.busy,
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "dt-card-head",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "dt-row-main",
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "dt-row-title",
									children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: "dt-card-title",
											children: title ?? localized(t, source.title)
										}),
										description && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(InfoTip, { text: description }),
										!source.installed && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Tag, {
											tone: "warning",
											children: t("sourceNotInstalled")
										})
									]
								})
							}), source.installed && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Switch, {
								checked: value.enabled,
								onChange: (enabled) => draft.edit({
									...value,
									enabled
								}),
								label: t("sourceEnable", { name: localized(t, source.title) })
							})]
						}),
						problem && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "dt-row-buttons",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								className: "dt-error",
								role: "status",
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(SetupMessage, {
									problem,
									lead: true
								})
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(CheckSetupButton, {})]
						}),
						!source.installed && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Hint, { children: t("sourceNotInstalledHint") }),
						source.installed && source.fields.filter((spec) => !spec.advanced).map(field),
						source.installed && source.id === "tapd" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(TapdCredentials, {
							config: {
								watches: Array.isArray(value.config.watches) ? value.config.watches.length : 0,
								agent: String(value.config.agent ?? ""),
								workspace: String(value.config.workspace ?? "")
							},
							onAddWatch: (watches) => draft.edit({
								...value,
								config: {
									...value.config,
									watches
								}
							})
						}),
						source.installed && advanced.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(DisclosureRow, {
							icon: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Icon, { name: "settings" }),
							title: t("advanced"),
							open: advancedOpen,
							onToggle: () => setAdvancedOpen(!advancedOpen),
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "dt-disclosure-body",
								children: advancedGroups.map((group) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [group.title && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									className: "dt-hint",
									children: group.title
								}), group.specs.map(field)] }, group.title || "default"))
							})
						})
					]
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(SaveBar, {
					...draft,
					status: restarts && running > 0 ? t("restartInterrupts", { count: running }) : void 0,
					onDiscard: draft.discard
				})]
			});
		}
		function SourceSettings({ focus }) {
			const { sources } = useSettings().settings;
			(0, react.useEffect)(() => {
				if (focus) document.getElementById(`dt-source-${focus}`)?.scrollIntoView?.({ block: "start" });
			}, [focus]);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "dt-form",
				children: [sources.filter((source) => source.id !== "p4").map((source) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(SourceCard, { source }, source.id)), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ConfigHistory, {
					blocks: ["source:"],
					except: ["source:p4"]
				})]
			});
		}
		function DroppedReplies({ items }) {
			const { t, navigate } = usePanel();
			const [open, setOpen] = (0, react.useState)(false);
			const target = (item) => item.ticket ? {
				route: {
					page: "execution",
					id: item.ticket.id
				},
				name: item.ticket.title
			} : item.thread ? {
				route: {
					page: "trigger",
					id: item.thread
				},
				name: t("term.thread")
			} : void 0;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(DisclosureRow, {
				icon: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Icon, { name: "dismiss" }),
				title: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
					t("sourceDroppedTitle"),
					" ",
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "dt-count",
						children: items.length
					})
				] }),
				open,
				onToggle: () => setOpen(!open),
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "dt-disclosure-body",
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Hint, { children: t("sourceDroppedHint") }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("ul", {
						className: "dt-list",
						children: items.map((item) => {
							const link = target(item);
							return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", {
								className: "dt-row",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Dot, { state: "idle" }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "dt-row-main",
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
										className: "dt-row-title dt-line",
										children: readableMarkers(t, item.preview) || t("empty")
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: "dt-row-meta",
										children: [
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Tag, {
												tone: "neutral",
												children: reasonLabel(t, item.dropped.reason)
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)(When, { at: item.dropped.at }),
											link && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
												type: "button",
												className: "dt-textlink",
												onClick: () => navigate(link.route),
												children: link.name
											})
										]
									})]
								})]
							}, item.id);
						})
					})]
				})
			});
		}
		/**
		* VsSaros fix (2026-11-06): replies whose send's result is not known. SuperAgent never sends them again by itself; a person
		* checks the conversation and redelivers one when it did not arrive.
		*/
		function UncertainReplies({ items }) {
			const { t, call, navigate } = usePanel();
			const [open, setOpen] = (0, react.useState)(true);
			const [done, setDone] = (0, react.useState)([]);
			const redeliver = useAction(async (id) => {
				await call("POST replies/:id/redeliver", { id });
				setDone((ids) => [...ids, id]);
			});
			items = items.filter((item) => !done.includes(item.id));
			if (!items.length) return null;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(DisclosureRow, {
				icon: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Icon, { name: "alert" }),
				title: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
					t("sourceUncertainTitle"),
					" ",
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "dt-count",
						children: items.length
					})
				] }),
				open,
				onToggle: () => setOpen(!open),
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "dt-disclosure-body",
					"data-testid": "uncertain-replies",
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Hint, { children: t("sourceUncertainHint") }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("ul", {
						className: "dt-list",
						children: items.map((item) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", {
							className: "dt-row",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Dot, { state: "warning" }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "dt-row-main",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: "dt-row-title dt-line",
									children: readableMarkers(t, item.preview) || t("empty")
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "dt-row-meta",
									children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: "dt-mono dt-clamp",
											children: item.unknown.reason
										}),
										item.unknown.at && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(When, { at: item.unknown.at }),
										item.ticket && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
											type: "button",
											className: "dt-textlink",
											onClick: () => navigate({
												page: "execution",
												id: item.ticket.id
											}),
											children: item.ticket.title
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
											type: "button",
											className: "dt-textlink",
											disabled: redeliver.busy,
											onClick: () => {
												redeliver.run(item.id);
											},
											children: t("sourceRedeliver")
										})
									]
								})]
							})]
						}, item.id))
					})]
				})
			});
		}
		function SourceRow({ source }) {
			const { t, navigate } = usePanel();
			const { setup } = usePanelData();
			const [filteredOpen, setFilteredOpen] = (0, react.useState)(false);
			const { problem, dropped, uncertain } = source;
			const { dot, label: state } = sourceMark(t, source.state);
			const { received, filtered, lastAt } = source.stats;
			const notes = source.enabled && !problem && !setup?.problem ? source.health.filter((item) => item.state === "error" || item.state === "paused") : [];
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", {
				className: "dt-row",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Dot, {
					state: dot,
					label: state
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "dt-row-main",
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "dt-row-title",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "dt-row-name",
								children: localized(t, source.title)
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "dt-status-text",
								"data-state": dot,
								children: state
							})]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "dt-row-meta",
							children: [
								received > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(LabelValue, {
									label: t("sourceReceivedLabel"),
									value: received
								}),
								filtered > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(LabelValue, {
									label: t("sourceFilteredLabel"),
									value: filtered
								}),
								lastAt && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(LabelValue, {
									label: t("sourceLatestLabel"),
									value: when(lastAt, t("lang"))
								})
							]
						}),
						problem && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
							className: "dt-error",
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(SetupMessage, {
									problem,
									lead: true
								}),
								" ",
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: "dt-textlink",
									onClick: () => navigate(settingsRoute("source", { source: source.id })),
									children: t("sourceOpenSettings")
								})
							]
						}),
						notes.map((item) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
							className: item.state === "error" ? "dt-error dt-clamp" : "dt-hint dt-clamp",
							children: [
								valueLabel(t, "health", item.name),
								t("labelSeparator"),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: item.code ? void 0 : "dt-mono",
									children: healthText(t, item)
								})
							]
						}, item.name)),
						source.filtered.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(DisclosureRow, {
							icon: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Icon, { name: "filter" }),
							title: t("sourceFilteredTitle"),
							open: filteredOpen,
							onToggle: () => setFilteredOpen(!filteredOpen),
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "dt-disclosure-body",
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("ul", {
									className: "dt-list",
									children: source.filtered.map((item) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", {
										className: "dt-row",
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Dot, { state: "idle" }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
											className: "dt-row-main",
											children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
												className: "dt-row-title",
												children: [
													actorName(t, item.actor),
													t("labelSeparator"),
													readableMarkers(t, item.preview) || t("empty")
												]
											}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
												className: "dt-row-meta",
												children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Tag, {
													tone: "neutral",
													children: reasonLabel(t, item.reason)
												}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(When, { at: item.at })]
											})]
										})]
									}, item.id))
								})
							})
						}),
						uncertain.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(UncertainReplies, { items: uncertain }),
						dropped.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(DroppedReplies, { items: dropped })
					]
				})]
			});
		}
		function SourceStatus() {
			const { t, call, navigate } = usePanel();
			const { setup } = usePanelData();
			const { data, error } = usePoll(() => call("GET sources"), []);
			const elsewhere = setup?.problem?.place === "deployment" ? setup.problem : void 0;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "dt-form",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(StatusHead, {
						hint: t("sourceStatusIntro"),
						settings: "source"
					}),
					elsewhere && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
						className: "dt-error",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(SetupMessage, {
								problem: elsewhere,
								lead: true
							}),
							" ",
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: "dt-textlink",
								onClick: () => navigate(setupPage(elsewhere.place)),
								children: t("setupFixLink")
							})
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(LoadState, {
						error,
						loading: !data
					}),
					data && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("ul", {
						className: "dt-list",
						children: data.filter((source) => source.id !== "p4").map((source) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(SourceRow, { source }, source.id))
					})
				]
			});
		}
		//#endregion
		//#region src/client/feed.ts
		/**
		* VsSaros addition (plan C): the change stream from dsh-superagent (`/orchestrator/api/stream`), shared by every view on
		* the page: one connection while anything listens, none after. Views read their data again when a topic they show changes,
		* and fall back to polling while the stream is down; after a reconnect every view reads again, since changes may have been
		* missed. The stream is read with `fetch`, as `EventSource` cannot send the same-origin header the API requires.
		*/
		const listeners = /* @__PURE__ */ new Set();
		const watchers = /* @__PURE__ */ new Set();
		let live = false;
		let connected = false;
		let current;
		let retry;
		let failures = 0;
		const emit = (topics) => {
			for (const listener of [...listeners]) listener(topics);
		};
		function setLive(next) {
			if (live === next) return;
			live = next;
			for (const watch of [...watchers]) watch(next);
		}
		/** One SSE frame: its `change` event names the topics that changed. */
		function parseFrame(frame) {
			let event = "message", data = "";
			for (const line of frame.split("\n")) if (line.startsWith("event:")) event = line.slice(6).trim();
			else if (line.startsWith("data:")) data += line.slice(5).trim();
			if (event !== "change" || !data) return void 0;
			try {
				const topics = JSON.parse(data).topics;
				return Array.isArray(topics) ? topics.filter((topic) => topic === "steps" || topic === "tickets" || topic === "desk") : void 0;
			} catch {
				return;
			}
		}
		async function connect() {
			const run = current = new AbortController();
			try {
				const response = await fetch("/orchestrator/api/stream", {
					headers: {
						"x-orchestrator-request": "1",
						accept: "text/event-stream"
					},
					signal: run.signal
				});
				if (!response.ok || !response.body) throw new Error(`stream ${response.status}`);
				const reader = response.body.getReader();
				const decoder = new TextDecoder();
				failures = 0;
				setLive(true);
				if (connected) emit("all");
				connected = true;
				let buffer = "";
				for (;;) {
					const { value, done } = await reader.read();
					if (done) break;
					buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
					for (let at = buffer.indexOf("\n\n"); at >= 0; at = buffer.indexOf("\n\n")) {
						const topics = parseFrame(buffer.slice(0, at));
						buffer = buffer.slice(at + 2);
						if (topics?.length) emit(topics);
					}
				}
			} catch {}
			if (run !== current) return;
			current = void 0;
			setLive(false);
			failures += 1;
			retry = setTimeout(() => {
				if (listeners.size) connect();
			}, Math.min(3e4, 1e3 * 2 ** Math.min(failures, 5)));
		}
		/** Listens to the stream's changes; the stream opens with the first listener and closes with the last. */
		function subscribe(listener) {
			listeners.add(listener);
			if (!current && !retry) connect();
			return () => {
				listeners.delete(listener);
				if (listeners.size) return;
				clearTimeout(retry);
				retry = void 0;
				const run = current;
				current = void 0;
				run?.abort();
				setLive(false);
			};
		}
		/**
		* VsSaros addition (2026-11-07, the module's "hot dispose"): ends the stream and its reconnect timer and forgets every
		* listener, whatever views are still mounted. The client plugin calls it when DSH disposes it (`apply` → `ctx.effect`): a
		* plugin reload loads a new copy of this module, and DSH's client has no `import.meta.hot`, so without this the old copy's
		* connection and backoff timer lived on until its last view unmounted (or forever, after a view that never did). A listener
		* that subscribes afterwards opens a new stream; a view of the old plugin that unsubscribes later closes nothing of it, since
		* a stream is closed only once no listener is left.
		*/
		function disposeFeed() {
			clearTimeout(retry);
			retry = void 0;
			const run = current;
			current = void 0;
			run?.abort();
			listeners.clear();
			setLive(false);
			connected = false;
			failures = 0;
		}
		/** Whether the stream is open now. */
		function useFeedLive() {
			const [value, setValue] = (0, react.useState)(live);
			(0, react.useEffect)(() => {
				watchers.add(setValue);
				setValue(live);
				return () => {
					watchers.delete(setValue);
				};
			}, []);
			return value;
		}
		/**
		* Loads data and keeps it current: read again whenever one of `topics` changes, and polled every `intervalMs` while the
		* stream is down (every `liveMs` while it is up, a safety net).
		*/
		function useLive(load, deps, topics, intervalMs = 5e3, liveMs = 6e4) {
			const isLive = useFeedLive();
			const poll = usePoll(load, deps, isLive ? liveMs : intervalMs);
			const reload = (0, react.useRef)(poll.reload);
			reload.current = poll.reload;
			const wanted = topics.join(",");
			(0, react.useEffect)(() => subscribe((changed) => {
				if (changed === "all" || changed.some((topic) => wanted.split(",").includes(topic))) reload.current();
			}), [wanted]);
			return {
				...poll,
				live: isLive
			};
		}
		//#endregion
		//#region src/client/characters.ts
		const CHARACTERS = {
			whale: {
				label: "Whale",
				body: "M65.3 20.9l5.1 .1 4.8 .9 4.8 1.7 4.3 2.3 3.8 3.1 3 3.4 2.3 3.8 1.6 4.3 .9 4.3 0 4.8-.8 4.8-1.4 4.3-2.3 4.3-3.2 4.3-3.4 3.3-4.3 3.1-7.2 3.5-7.6 1.7-7.2 .1-9.6-1.6-3.3-1-2.9-1.7-8.8-8.9-6-4.7-3.3-.5-7.7 1.1-4.8-.1-4.7-1.2-1.9-1.2-1-1-.5-1.5 .4-1.4 1.1-1.3 1.9-1.3 4.7-1.5 7.7-.6 1.1-.5 .7-1 0-1.4-2.8-7.2-1.2-5.3-.1-4.3 .4-1.4 .9-1.2 1.9-.2 2 1 2.2 2.3 2.2 3.4 3.2 7.6 1.9 9.7 .5-.1 1.1-7.2 1.8-4.8 3.2-5.2 3.9-4.3 4.9-3.9 5.6-2.9 5.8-1.9z",
				paints: [[
					"M93.3 55.8l1-.3 .1 1.2-2.4 5.3-3.4 4.8-3.8 3.8-4.8 3.4-5.7 2.8-4.8 1.5-4.8 .4 20.1-17.4 5.2-3.7z",
					"#fff",
					1
				]],
				shade: "M88.6 29.5l2.4 2.9 1.9 2.8 2.4 6.3 .5 3.3 .1 5.3-1.5 6.6-1.9 4.3-2 3.3-4.8 5.4-5.7 4.3-7.2 3.3-6.2 1.5-6.7 .1-3.3-.2-9.6-1.8-3.3-1.5-2.4-1.9-8.6-8.9-5.3-3.9-3.3-.1-2.9 .2-3.3 .8-5.8 0-4.3-1-2.9-1.9 .6-.6 3.8-1.3 10.5-2.5 4.3 .9 1.4-.1 2.2-1.7 .5-1.4-.3-1.5-1.2-1.4-2.2-1.4-1.2-1.9-.6-12 .4-3.3 .5-.5 2.9 3.8 2.4 4.8 1.9 5.7 .7 5.8 .7 2.8 2.1 2.4 2.7 5.5 3.8 4.3 2.9 2.2 3.3 1 3.4-.4 6.2-3 7.1-4.5 7.3-5.6 6.6-5.9 5.9-6.5 3.7-5.3 1.7-4.2 .1-2.9z",
				light: "M55.6 22.8l1.9-.3 1.5 .3 .6 1 .1 .9-2 4.3-3.8 5.3-5.8 6.2-5.4 4.4-4.8 2.3-1.4 0-1.2-.5-.8-1.9 .5-3.3 2.5-4.8 3.3-4.3 2.4-2.4 5.3-3.9zM19.3 28.1l-1.4 2 .3-1.1zM21.7 49.1l.6 .5-.3 .5-.8 0zM35.8 52l1.2-.4 .9 .7 .7 1.6-.4 .9-1.2 .1-2.6-.5zM7.2 52.9l-2.9 2.9 1.2-1.6z",
				eyes: [[
					72.5,
					48.4,
					9.3,
					23,
					-15.8
				], [
					85.6,
					43.4,
					7,
					22.9,
					-21.2
				]]
			},
			star: {
				label: "Star",
				body: "M40.1 4.4l1.5-.4 1.9 .1 5.2 1.1 1.9 .9 13.2 14.9 17.1-.8 5.2 1.1 1.8 .9 1.7 1.6 .7 2.4-.4 1.9-9.7 23.6 5.6 23.7 .1 1.9-.6 1.4-2.1 1.8-2.3 .5-19.9-1.8-16.6 15.5-1.9 1-1.9 .3-7-1.5-2.6-2.1-.9-2.4-2.8-24.1-16-13.6-1.1-1.5-.5-1.9 .4-1.9 1.2-1.5 18.9-13.6 7.1-24.6 1-1.7z",
				shade: "M52 7.7l14.3 16.1 1 2.9 .3 3.1 19.4-1.3 2-1.4 .7-2.3-.4-1 .5 .5 .5 1.9-.4 1.9-9.8 23.2 5.5 23.1 .1 3.4-2 2.4-2.8 .8-19.4-2.1-1.9 1.4-14.7 14-2.4 1.4-3.3 .1-4.7-1-2-1 .6-.2 3.3 .8 2.8 .1 5.1-2.1 .7-.9 .4-2.4-2.6-22.7-.3-.3-1.4 .2-1.4 .7-5.7 .7-5.6-1.2-16.7-13.8 1-.1 5.2 1 3.8-1.1 1-.7 1.9-.4 .4-.4 1.5 .3 .4-.4 1 .2 18-12.8 6.7-23.5 0-1.8-.4-.5-.3-1.9 .4-2.4z",
				light: "M40.1 4.4l2-.1 4.7 1 .7 1-.5 1.4-2.8 1.5-6.6 23.1 .7 1.2 .6 .3-18.1 12.5-1.8 2.1-3.4 .7-5.2-1.2-.3-.4 .3-.9 1.4-1.4 18.3-12.9 .9-2.3 6.4-22.7 .8-1.4z",
				eyes: [[
					53.9,
					53.4,
					7.2,
					18.8,
					-10
				], [
					65.1,
					49.2,
					7.2,
					18.8,
					-10
				]]
			},
			moon: {
				label: "Moon",
				body: "M45.8 4.2l4.7-.2 4.2 .4 10.2 2.4 3.7 1.6 3.6 2.1 3.3 2.5 3 3.1 4.6 6.7 3.4 8.3 1.5 8.8 .1 4.6-.8 7.8-2.6 8.8-3.9 7.7-5.1 6.7-6.1 5.3-4.1 2.6-3.6 1.6-27.2 10.2-2.8 .7-2.6 0-5.7-1.3-2-.8-1.9-1.7-1.1-2.6-6.5-37.7-.2-5.2 .8-7.7 1.3-5.2 3.1-7.8 4.2-6.7 3-3.6 3.9-3.6 6.3-4.2 4.1-1.8z",
				paints: [[
					"M57.6 9.9l.2-.3 .2 .3 2 4.7 1.9 1.9 2.6 .5 1.5-.7 1.1-1.1 .4 .4-.1 1.6-.7 1.5-2.2 2.5-1.6 .7-2 0-1.6-.8-1.3-1.4-.8-2-.4-2.6 .1-3.1z",
					"#1783FF",
					1
				]],
				shade: "M74.3 13.5l2.1 1.5 .3-.4-.3-.6 2.1 2.1 4.6 6.7 3.1 7.4 1.5 7.6 .1 10.4-.6 4.6-2.5 8.3-4.2 8.2-3.1 4.2-5.7 5.7-6.2 4.2-4.6 2-28 10.3-4.1 0-5.2-1.1-2-.9-.5-.7 .5 .5 1.5 0 3.6 1 2.6-.3 5.7-2.1 2.1-2.1-5.4-31.5-.2-4.1 .4-1.1-.1-2.6 .5-3.6 1.8-7.7 2.8-6.7 1.9-3.1 3.9-5.2 3.2-3.1 2.5-2 5.2-2.9 3.1-1.1 3.1-.8 2.1 0 .5-.4 2.6 .2 1-.3 1.6 .4 1-.5 2.1 .8 1-.8 2.1 1.2z",
				light: "M38 6.3l1.7-.3 2.5 .2 .6 .4 1.5 0 .5 .5 1.6 .3-3.1 1.3 .4 .7-2.5 1.6-.5 1-2.5 2.1-2.7 2.9-6.2 7.9-1.5 2.7-1 .9-1.2 2.6-1.4 1-1.3 3.7-1.3 .3-6-1.4-1 3.6-.8 0 .9-3.6-.5-1 1.1-3.6 2.7-5.7 4.1-6.2 5.7-5.8 3.1-2.4 3.6-2.2z",
				eyes: [[
					51.6,
					48.5,
					8.4,
					22.1,
					-10
				], [
					66.8,
					42.9,
					8.4,
					22.1,
					-10
				]]
			},
			wave: {
				label: "Wave",
				body: "M46.1 4l6.1 .3 9.6 2.1 4.5 1.8 4.1 2.4 3.5 2.8 4.4 4.8 2.6 4 2.1 4.1 2.2 6 4.8 26 .5 5.3-.3 4.1-1.2 3.8-1.5 2.8-2.4 2.5-2.1 1.4-3.1 1-3 .3-8.1-1.5-3.2 5.3-2.1 2.1-2.5 1.5-2.8 1-3 .4-9.1-1.6-2.7 4.2-3.4 3.1-4 1.7-4.6 .1-7-1.5-3.5-1.9-3.4-3.5-2.1-4-1.5-5.6-3.7-20.7-.6-5.6-.1-5 .5-6.1 2.3-9.6 2.3-5.5 2.7-4.9 2.7-3.7 3.2-3.6 4.2-3.6 4.7-2.9 4.4-2 4-1.2z",
				paints: [[
					"M61.6 48.5l2.2-.3 2 1.1 1.1 2.2 .3 3-.6 3.1-1.5 3.5-2.5 4.1-2.4 2.8-5-2.2-3-2.2-2.3-3-.7-3.5 .6-2.6 1.8-2.1 1.6-.7 1.5 0 1.5 .6 1.5 1.3 2-3.6z",
					"#fff",
					.4
				]],
				shade: "M69.3 13.6l2.6 1.3 .5-.3 .5-1.3 2 1.7 .5 0 2.5 2.7 3.5 5.5 3.6 8.6 1.5 6.6 3.5 19.7 .5 5.5-.4 4.6-2 5-1 1.6-2.6 2.5-3 1.5-2.1 .5-4 0-6.6-1.4-1.4 2.9-1.9 2.5-2.7 2.6-3.1 1.5-2.5 .6-4 .1-7.1-1.5-1.5 2.8-2.6 3-2 1.6-3 1.4-4.5 .6-7.1-1.5-3.6-1.5-3.5-3.1 6.6 1.5 2.8-.5 .5-.5-.3-.5 3.2-2-.4-1 1.4-1.5-.3-1 .7-1.6-.2-2.5-3.4-19.2 .3-.5-.6-5 .5-.5-.1-4.6 .4-.5 .3-4 1-4.1 1.5-4.5 3.8-7.7 5.5-6.9 3.1-2.6 6.5-3.9 7.6-2.2 3.1 0 .5-.4 3 .5 1-.5 2.5 1z",
				light: "M36.5 6.1l2-.3 .5 .6 4.1 .5 1 .7-3.3 1.5-.3 1.2-3 2-.3 .8-2.8 2.6-3.5 4-3.9 5-2 3.6-1 .5-1.7 4-1.5 .5-1.4 4.6-1.6 .2-.5-.4-5.6-.9-.4-.4 1.4-5.1 1.5-3.5 2.6-5.1 4-5.5 6.6-6.2 4-2.5z",
				eyes: [[
					47.5,
					37.2,
					8.4,
					22.1,
					-10
				], [
					61.6,
					31.9,
					8.4,
					22.1,
					-10
				]]
			},
			squircle: {
				label: "Squircle",
				body: "M54.5 4.2l3.9-.2 3.7 .3 11.6 2.7 3.1 1.6 2.8 1.9 2.6 2.7 2.2 3.1 2.4 4.8 1.9 5.8 3.7 19.4 .8 11.1-.4 4.7-1 4.7-1.3 3.5-1.8 3.4-4.8 5.8-6.4 4.7-8 4-14.2 5.3-9.5 2.2-7.4 .1-10.5-2.2-5.3-2.5-4.3-3.7-3.3-4.8-2.7-6.3-2.4-9.5-2.8-17.9-.2-7.8 1.3-7.9 2.2-5.3 2.8-4.2 4.1-4.2 4.3-3.1 6.3-3.4 11.6-4.6 7.9-2.7z",
				shade: "M80.5 11.6l2.1 2.1 2.1 3.2 3.2 7.3 2.1 8.4 2.7 15.8 .5 7.9-.6 7.4-2 6.3-3.8 6.3-4.2 4.3-2.6 2-6.9 3.8-15.2 6.2-9.5 2.7-6.8 .6-6.2-.7-8.5-2-5.8-3.2-3.2-3.3 .5 .4 1.1-.2 5.8 1.4 2.1-.8 1.4-.7-.3-.5 1.4-1.1-.1-1 .8-.5 0-1.1 1.1-1 .1-2.1 .4-.6-.2-3.6-2.4-17.9-.2-9.5 .8-5.3 1.1-3.6 1.2-2.7 2.2-3.5 2.7-2.8 3.1-2.5 5.8-3.2 17.9-6.9 5.3-1.4 8.4-1.4 1.6-1.1 .5 .1 .9-1.5z",
				light: "M39.4 8.4l1.2 0-1.6 .7-1-.1 1-.1zM36.8 9.5l1 0 .6 .9 4.2 .6 .7 .6-3.8-.4-.3 .4 1.9 .3 .1 .7-3.2 1.6-6.9 5.8-5.3 6-4.7 6.1-3.8 3.7-.2 .5-1.8 .1-6.8-1.7 .4-3.6 2.1-4.2 2.2-3.2 4.2-4.3 4.2-3 3.1-1.8 5.3-2.5zM35.1 10.5l1.7 0-.5 .4zM36.5 11.1l.3-.5 2.2 .1 .4 .4-.4 .3z",
				eyes: [[
					52.6,
					52.4,
					8.4,
					22.1,
					-10
				], [
					67.3,
					46.9,
					8.4,
					22.1,
					-10
				]]
			},
			zed: {
				label: "Bull",
				body: "M77 4.4l1.1-.4 1.1 .2 1.2 1.3 2 9.8 2.2 5.9 .4 2.8-.3 2.1-.8 1.7-4.7 5.1-1.3 1.9-.4 1.7 .1 1.6 1 1.7 4.4 .2 3.8 1.3 2 1.7 .6 1.6-.3 1.7-.7 1.1-3.5 2.7 1.7 6 .4 5.9-.8 6.6-1.9 6-3.4 5.9-4.4 5.3-5.5 4.4-6 3.1-6.5 2-7.1 .7-6.5-.7-6.5-2.1-6-3.4-4.8-4.4-3.5-4.9-3.1-6.7-3.3 1.1-2.7 .3-2-.6-1.1-1.1-.3-2.2 .9-2.7 2.9-3.8 4.6-3.8 1.8-7.1-6.3-1.8-1.6-1.3-1.3-1.8-.6-2.7 0-6.6-1.4-8.7 .2-1.1 1.5-1.4 1.1-.1 1 .5 5.5 7.9 2.2 2.2 2.7 1.4 4.9 .4 .5-.1 6.5-5.1 6.6-3.2 6-1.6 8.7-.7 3.8-.9 2.7-1.5 3.9-3.2 3-3.8 2.4-4.9 2.1-10z",
				paints: [[
					"M61 36.5l1.9 .7 1.4 2-.7 5.4 .3 .4 2.8-1.2 1.1 0 1 .9 .5 1.6-.5 .8-1 .5-7.1 2.4-1.1-.5-.9-1.6 1.4-5.4-.5-.6-3.3 1.1-1.1-.1-1.6-1-1-1.6 .5-.9z",
					"#fff",
					1
				]],
				shade: "M80.2 5.5l.6 1.6 1.3 8.2 2.5 6 .2 3.7-.1 1.1-1.2 2.2-5.2 5.4-1.1 3.3 .9 2.7 3.8 3.9 1.6 .1 4.4-1.4 1.2 1.2 .1 1.1-.2 1.7-.6 1.1-3.6 2.7 .9 2.2 1.1 5.4 .1 6-1.1 6.5-2.3 6-3.8 6-6 6-4.9 3.3-5.9 2.6-7.1 1.7-7.1 .1-6-1.1-5.9-2.3-4.4-2.7-4.4-4.5 3.8 .4 5.5-1.5 7.6-3.9 6.8-4.7 7.9-6.5 7.1-6.9 5.4-6.5 4.4-6.7 1.8-4.4 .4-3.2-.3-1.1-3.3-3.8-.8-2.8 .8-2.7 6.2-7 .8-2.2-.1-2.7-1.7-4.4-.8-8.2zM14.9 29.9l.1-.5 4 6.5 2.3 2.7-1.4 .1-2-.6-3.6-7.1zM24.3 44.6l1-.3 1.1 .2 3.3 2.9 1.7 .5 .3 1.6-.5 2.2-1 1.6-1.6 1.5-1.6 .7-1.7 .1-3.2-2.2-2.2 0-2.7-.6-2.9-1.6 3.9-1.6 2.2-1.7 2.2-2.3zM21 68.6l.5-.5 1.1 .1 1.1 .5 .8 1 .6 2.7-.1 1.1-.7 1.1-.6 .1-2.2-1.2-2.7 1.1-3.8 .6-2.7-1.2 3.4-1.6z",
				light: "M77 4.4l.6-.2 .1 .7-1.2 .8-.1-.8zM74.2 15.8l.6 1.1 .1 2.7-.6 2.2-1 1.6-5.5 5-1.7 .7-3.3 .3 .1-.6 2.1-1.2 4.2-3.6 2.7-3.9zM11.7 28.9l.8 0-.1 .5-1.2 .8-.1-.8zM44.3 32.1l3.1 0 .8 1.1 0 1.1-1.9 4.3-3 4.1-1.7-1.1-2.1-.8-4.4-.6-4.4 .1 5.5-4.4zM22 54.4l.6 0-.3 .6 .2 .5 2.3 2.7 .4 1.7-1 .9-4.8 2.3-7.1 7.8 0-1.8 2.1-3.3 6.4-5.4 1.2-4.3z",
				eyes: [[
					61.8,
					69,
					9.5,
					22.3,
					-10.5
				], [
					78.4,
					62.7,
					6.9,
					22.2,
					-11.2
				]]
			},
			hex: {
				label: "Blossom",
				body: "M38.8 4.2l2.6-.1 6 1.3 2 1.3 3 3.3 12-4.5 2-.5 6.5 1.1 2.9 1.6 4.9 6 .8 2 .3 2-.2 2.5-1.9 7-1.3 2.2-1.9 1.8 2.9 1.3 1.8 1.7 10.1 12.5 1.5 3 .1 4-1.8 7-.9 2-2.8 2.7-7.1 2.7-5.2 20-.8 2-1.4 1.9-1.5 1.1-6.5 2.6-3 .2-6.5-1.6-2-1.4-4-4.9-16 5.7-2 .1-4.5-1-3-1.2-5.2-6-1.3-3 0-3.5 2-8.5-10.8-13.4-1.4-3-.3-2 .3-2.5 1.7-6.5 1.8-3 2.2-1.8 5.9-2.2 2.1-.4 2.5 .3 .4-.4-.7-2.5 .1-2.5 4.8-18.5 1-2.5 2.9-2.9z",
				shade: "M49.7 7.7l.2-.4 .5 .4 2 2.3 0 .7 1.6 1.5 1 2 .1 1.5-.3 .5 .6 1.3 17.5-6.5 2.5-1.3 1-1.5 4.5 6 .6 1.5 .3 3-1.9 8-1 2-3 3-.3 1 .4 .5-1.7 3 .1 .5-.5 .5 0 .7 5.5-2.2 1.5-1.5 2 2 8 10 1 1.5 1 2.5-.1 4-1.9 7-1.1 1.9-2.9 2.5-6.8 2.5-4.7 19-1.5 3.5-2.5 2.5-6.5 2.6-4 0-5.5-1.4-2.2-1.7-3.2-4 4.9 .8 2.5-1.4 1.5-2.6 .7-2.3 1.7-6.5-.4-.3-.6 .8-.7 3.5-1.1 1.5 .3 .5-.3 .5-.7-.5-1.4-5.5-.5 1-.2 2-.9 1-.1 1.5-1.1 2-2.7 2.8-1 .4-1 .1-15.5 5.8-3-.1-4.5-1-2-1-2-2-2.2-3 .2-.2 4 .9 2-1.1 1.7-1.6 1.3-3.2 1.7-6.3 1.1-2.5-.3-.3-.5 .2-6.5-.3-.5-.5-2 0-.5-.5-1.7-.1-10.4-13.4 4.1 .7 3.1-1.7 1.3-2 2.5-8.5 .9-1.5 1.7-1.3 6.5-2.7 2-1.5-.3-.5 .3-.5 1.5-1.2 1.5-3 5.6-20.3 1.9-2 6-2.4 1.1-.6zM73.2 31.2l1.5 0-.8 1-34 12.7-1 .1-1.5-.5-2 .8-1.9-2.6 .4-.9 2 .5 1.5 1 .5-.4 1 .5 1-.3 1 .4 3-1.5 1 .1 3-1.6 1 .1 3-1.6 1 .1 3-1.6 2.5-.5 1.5-1 2.5-.5 1.5-1 2.5-.5 1.5-1 2.5-.5 1.5-1 1 0zM61.3 74.6l.1-.2 .4 .2-.4 1.7z",
				light: "M33.4 6.2l3 .1 1.9 .9-.1 .5-1.8 2.5-3.4 3.5-4.5 17-3.6-.9-1 .4 0-1 4.4-16.5 0-1.5 2.1-3.1zM68.2 6.2l1.2 0zM14.9 37.7l3.5 .9 .4 .6-.3 1-5 5.5-1.1 4.6-2.5-.5-2 .1 0-1.7 1-4.5 1-2.5 2-2.1zM19.4 71.6l4 .7 1.8 .8-1.2 1-1.1 5.1-4.5-.5-.5-.6 1.4-5z",
				eyes: [[
					49.8,
					55.5,
					6.7,
					17.7,
					-10
				], [
					61.6,
					51.1,
					6.7,
					17.7,
					-10
				]]
			},
			gumdrop: {
				body: "M38.7 4.5l4.4-.5 4.6 .8 4.1 1.9 3.7 3.2 23.2 36.6 2.3 5 1.4 5.1 .7 6.4-.7 6.4-1.8 6.1-3.1 5.7-4.1 5.1-5.2 4.2-5.8 3.1-6 1.8-6.4 .6-6.4-.6-6-1.8-5.9-3.1-5.1-4.2-4.1-5.1-3-5.4-1.9-6.4-.7-6 .5-5.9 9-41.6 2-4.1 2.6-3.2 3.4-2.5z",
				shade: "M54.9 9.5l1.9 2.3 22.9 36.5 1.8 4.6 .9 3.7 .6 4.1-.1 5.9-1.4 6.4-2.3 5.5-3.7 5.4-4.1 4.2-4.5 3.3-7.3 3.2-6.4 1.2-6.4 0-5.1-.9-5.9-2.1-5.5-3.3-4.6-4.1 .5-.3 4.1 .8 5.5-1 6.4-2.6 7.3-4.5 7.2-5.7 6.5-6.4 5.5-6.9 3.5-5.9-18.1-37 1.1-3.7 .2-2.3z",
				light: "M37.1 4.9l2.5 0 .8 1.4-.5 2.1-1.8 2.9-3.2 3.2-3.2 2.1-2.3 .7-1.8-.1-.7-.9 .1-1.8 2.4-4.1 2.7-2.8z",
				eyes: [[
					52.1,
					40.3,
					9.7,
					22.9,
					-15.2
				], [
					64.8,
					35.6,
					6.3,
					23,
					-27
				]]
			},
			peanut: {
				body: "M43.5 4l6.6 .7 5.8 2.2 5.4 3.8 4.1 4.7 2 3.8 1.4 4.3 1.3 11.9 1 4.3 1.6 3.8 5.8 10.5 1.4 3.8 .8 4.3 .1 6.2-1 5.7-2.1 5.5-3.2 4.9-4.1 4.3-4.8 3.4-5.6 2.4-5.7 1.3-6.1 .1-5.8-1.1-5.7-2.2-4.7-3.1-4.3-4.1-3.3-4.8-2.5-5.7-1.2-5.7-.1-6.7 1.7-9 .4-4.3-.5-4.7-2.5-9.6-.6-3.8 .2-5.2 1.2-5.2 1.5-3.4 2.2-3.3 2.5-2.9 2.8-2.3 3.4-2.1 3.4-1.4 3.8-.9z",
				shade: "M62.7 12.6l2.6 2.8 2.8 5.8 1.1 4.2 1 11.9 1 3.4 2.3 4.7 4.2 6.7 1.9 4.7 .9 3.8 .2 2.9-.1 6.2-.5 3.3-1.9 5.3-3.4 5.7-3.4 3.8-4.2 3.3-5.7 2.9-4.8 1.4-5.7 .6-6.2-.6-3.8-1-5.2-2.3-4.8-3.4-2.9-2.8 3.9 .8 5.2-.7 6.2-2.5 5.7-3.3 6.7-5.1 6.2-5.9 5.1-6.2 3.5-5.7-1.1-2.8-2.4-2.4-3.2-1.7-11.5-4.1-2.7-1.8-1.6-2.4-.2-2.4 .8-2.9 7.8-8 4.9-7.7 1.6-5.2z",
				light: "M35.9 5.4l3.2-.2 1.3 .7 .5 1-.5 3.3-2.9 4.8-4.1 4.1-4.8 3.3-4.2 1.5-1.5 0-1.4-.6-.7-1.2 .2-2.4 1.9-3.8 2.4-3.3 4.3-3.9z",
				eyes: [[
					50.9,
					31.5,
					8.7,
					20.5,
					-11.9
				], [
					64.2,
					26.5,
					5.7,
					20.3,
					-16.3
				]]
			},
			saucer: {
				body: "M45 22.7l6.7 .1 6.7 1.9 4.3 2.5 3.5 3.1 2.8 3.5 2.5 4.5 6.8 .9 5.6 1.2 4.5 1.6 3.5 2.1 2.8 2.8 1.3 3.5-.5 3.5-2 3.5-2.6 2.8-3.5 2.8-4.5 2.8-5.1 2.6-12 4.4-13.6 3.1-13.6 1.5-12.6-.3-5.5-.7-5-1.2-4.1-1.6-3.5-2-2.8-3.1-1.1-3 .5-3.5 2-3.6 2.7-3 3.7-2.9 10.3-5.6 .7-5.1 1.5-4.5 2.6-4.5 3.1-3.5 3-2.4 3.5-2 3.5-1.4z",
				shade: "M66.5 31.3l.3-.2 .6 .7 1.9 2.5 2 4.5 1.6 1.5 .1 1.5-1.7 1.7-3 1.2-3.1 .5-3.1-.3 4-8.1 .7-3.5zM94.9 47.4l1.1 3-.5 3.5-2.1 3.5-4 4.1-5 3.5-6.1 3.1-7 2.9-6.6 2.1-8 2-9.1 1.5-6.5 .6-11.6 0-4.5-.2-8-1.4-4.6-1.5-3.6-2.1 4.1 1.2 5.1 .8 7 .3 6-.2 15.1-1.9 15.6-3.6 14.5-5.1 5.4-2.5 5.3-3.1 4-3 2.3-2.5 1.2-2.1zM7.3 71l.7 .5z",
				light: "M40.6 23.7l2.8 0 .8 .5 .7 1.5-.8 3.6-2.6 4-3.9 4-4.5 3.2-4.6 1.7-2.5-.4-1-1.4 0-1.6 .9-2.5 2.1-3.5 2.6-3 3-2.6 3.5-2.1zM22.4 47.4l.7 0-.5 .5 0 1.5 .4 .8 2 1.4 3 1.2 9.1 2 15.1 1.1-.2 1.5-2.2 3.6-3 2.5-4.9 2.5-6 2-7.9 1.5-6.5 .5-7.1-.4-4.9-1.1-3-1.5-1.6-1.7-.6-2.3 1.1-3.1 2.9-3.5 4.1-3.5 4.1-2.6z",
				eyes: [[
					53.6,
					45,
					7.8,
					18.4,
					-14.5
				], [
					66.2,
					40.3,
					5,
					18.3,
					-25.1
				]]
			},
			bunny: {
				body: "M49.3 4.4l1.5-.4 2 1.2 1.6 2.7 1.2 3.4 1.6 8.9 .2 6-.2 6.4 .6 3 2.4 2.5 5.4 3 3.4 2.4 5.1 5.5 2.4 3.9 1.7 4 1.1 4.4 .4 4.5-.5 5.9-1.6 5.5-2.8 5.4-3.6 4.5-4.6 3.8-4.9 2.7-5.5 1.7-5.9 .7-6-.5-5.4-1.7-4.9-2.5-4.7-3.7-3.8-4.5-2.7-4.9-1.8-5.5-.7-5.9 .6-6.5 1.9-5.9 3.1-5.4 4.6-5.5-.4-2-3.4-8.4-1.8-6.9-.6-6.9 .3-3 .6-2 1.3-1.4 2-.1 2.5 1.5 2.1 2.5 4 6.9 2.1 5.5 1.7 5.9 1.5 2.1 1.8-1.6 .7-2-.4-12.4 1-8.9 1.6-4.9z",
				shade: "M52.7 5.4l2.1 3.5 1.9 7.4 .7 7.9-.5 8.4 .8 3.6-4.4-2.5-2.1-2.6 1.4-17.3zM31.2 15.3l.3-.5 2 2.5 2.9 4.9 2.5 6 1.7 6.4 1.4 2.5 0 .5-1.1 .9-4.5 1.9-2.4 .2-1.2-.6zM71.5 46l3.6 4.4 2.9 6 1.5 6.4 .1 5.5-1.1 6.3-2 5-3.4 5.4-3.5 3.6-4 2.9-6.4 3-4 1-6.9 .5-5.9-1-5.5-2-5.4-3.5-3.6-3.4 2.6 .7 2.5 .1 2.9-.5 4-1.3 8.4-4.6 8.7-6.8 7.4-7.9 5.3-7.9 1.3-3 1-3.5 .2-2.9-.2-2z",
				light: "M49.3 4.4l.6 0-3.6 6.2 1-3.7zM26 13.3l.5-.4 .2 .4-1.7 2.2 0-.7zM44.8 34.6l.5-.1 1.2 1.1 .8 1 0 .7-.5 .3-4-.5zM45.1 42.5l.8 0-.3 1-2.4 4.5-3.8 4.4-4.1 3.5-3.8 2.4-4 1.6-2.9 .1-1.8-1.1-.4-2.5 1.1-3.5 3.5-5.4 3-3.1 .2 1.6 .8 .8 3 .1 4.4-1.2z",
				eyes: [[
					59.2,
					69.2,
					8.2,
					19.3,
					-12
				], [
					72.9,
					64,
					5.6,
					19.1,
					-15.4
				]]
			},
			kitty: {
				body: "M62.4 4.2l1.6-.1 1.5 1.2 7.4 21.3 3.7 6.4 6.2 7.4 3.1 5.9 1.5 4.8 .7 5.3-.2 5.4-1.1 5.3-3 7.4-4.4 6.4-5.3 5.4-6.9 4.6-7.5 3.1-8 1.7-8 .2-7.4-1.4-4.3-1.5-3.7-1.8-3.8-2.5-3.1-2.7-2.7-3-2.5-3.7-1.9-3.7-1.4-4.3-.9-5.3 .1-5.8 1.4-7 1.6-4.2 2-3.8 .8-3.2 .2-20.2 1.1-1.4 1.1-.3 1.1 .3 12.2 9.7 5.9-2.5 8-2.1 3.2-1.8 2.3-2.4 8.3-16z",
				shade: "M64.9 5.8l.1-.3 .7 .3 6.5 19.7 3.1 5.9 2.5 3.2-1.6-.8-2.6-2.4-5.1-8zM79.4 36.7l2.2 2.1 1.6 2.2 3.3 6.9 1.5 6.9-.1 6.4-1.6 7.5-3.1 6.9-3.8 5.3-5.3 5.4-6.4 4.3-7 3.1-6.3 1.6-4.3 .6-5.3 0-7.5-1.1-5.8-2-5.9-3.3-5.9-5.4 2.7 .7 3.2-.1 3.7-.8 5.2-1.9 10.3-5.5 11-7.8 10.7-9.6 7.8-9.1 3-4.6 1.6-3.4 .7-3.2z",
				light: "M62.4 4.2l.5-.1 0 .6-.8 1.1-4.5 14.4 .2 2.7-.3 1.6-1.1 1-2 .6-6.9-.5 2.6-1.3 3.1-3 8.1-16zM18.7 20.7l1.1-.5 0 .8-1.1 .9-.6-.1zM39.5 27.7l2.6-.3 1.9 .8 .4 1.6-.7 1.8-4.2-1.5-5.4 .2 0-.5zM16 47.4l.3 4.2 1.6 2.2 3 2.1-.6 .5-3.7 .6-1.1-.3-1.1-1.1-.4-1.8 .4-2.7z",
				eyes: [[
					59.6,
					65.1,
					9.4,
					22.6,
					-11.9
				], [
					77.5,
					58.4,
					7,
					22.5,
					-14
				]]
			},
			beacon: {
				body: "M40 4.1l2.7 0 2.5 .9 2 1.7 1.1 2.1 .5 2-.2 2.1-2.1 4.1-.4 1.6 1.5 7.7 9-3.1 4.1-.2 18.5 4 3.1 1.6 2.4 2.3 1.3 2.1 .9 2.6 5.8 33.4-.4 3.1-1.3 3.1-2 2.5-2.6 1.9-41.7 15.7-4.1 .7-19.6-4-3.5-1.9-2.5-2.5-1.2-2.1-.8-2.6-5.7-32.9 .4-3.1 1-2.7 1.7-2.5 2.4-1.9 28.4-10.9-1.5-9.3-.7-1-3.5-3.3-.9-1.9-.4-2 .5-2.6 1.1-2.1 1.7-1.5z",
				shade: "M47.1 7.2l.4 0 .8 1.6 .3 2-.2 2.6-2.5 4.7 1.5 8.2 0 2 .5 .6 .1 1.5 .5 1-1.2 .4-1.3-.4-.3-.5-1.9-10.3-4.1-1.5-3.2-2.6 3.1-.9 3.2-2.2 2.5-2.6zM84.2 30.9l1.2 1.1 1.5 3.6 5.7 32.4 0 2.6-1 3.6-1 1.5-3.1 3.2-4.2 1.9-40.6 15-4.2 0-16.4-3.6-3.6-1.4-2.6-2.2 .5 .4 17.5 3.4 3.8-1.2 5-3.4 1-1.3-5.4-30.3 .2-.6 3.1-3.4 40.2-15.1 2-3.6z",
				light: "M38.5 4.7l2 0-.1 1-.8 1.4-2.6 2.2-1 .4-1.1-.1-.1-.8 .7-1.6 1.5-1.6zM55 23.7l1.1 .1-1.6 .6-.9-.2 .9 0zM52.4 24.7l1 0-3 1.2-.9-.1 2.4-.6zM48.3 26.3l1 0-1.5 .6zM40 29.4l1.1 0-3.1 1.2-.9-.2 2.5-.5zM35.9 30.9l1 0-3 1.2-.9-.1 2.5-.6zM31.8 32.5l1 0-3 1.2-.9-.2 2.4-.5zM40.2 33l.4-.4 1-.1 1.6 .8 3 .7-1.5 .5-4.1 0-.9-1zM27.7 34l1 0-3 1.2-1-.2 2.5-.5zM23.6 35.6l1 0-3 1.1-1-.1 2.5-.5zM19.4 37.1l1 0-2.4 .8-.5 .7 15.4 3.3 .5 .3 .3 1.1-1.1 2.6-3.3 3.3-3.1 1.5-17.5-3.6-.6-1.2 .5-1.6 3.2-3.7 2.1-1.4 2.5-1.1 1 0 .6-.5 1 0z",
				eyes: [[
					55.5,
					65.3,
					8.4,
					22.1,
					-10
				], [
					74.2,
					58.3,
					8.4,
					22.1,
					-10
				]]
			},
			plus: {
				body: "M44.6 4.3l3.3-.1 11.9 2.5 2.5 1.3 1.3 1.4 .7 1.6 2.1 11.4 4.1-1.2 2.1 0 12.3 2.6 2.8 1.6 1.2 1.5 .7 1.5 3.8 21.6-.5 3.1-1 1.5-1.3 1.3-17 6.6 3.4 20.4-.4 2.5-1.2 2.1-2.3 1.6-19 6.9-2-.2-11.9-2.5-2.5-1.3-1.3-1.4-.7-1.6-2.1-11.4-4.1 1.2-2.1 0-12.3-2.6-2.8-1.6-1.2-1.5-.7-1.5-3.8-21.6 .5-3.1 1-1.5 1.3-1.3 17-6.6-3.4-20.4 .2-2 1.1-2.2 2.6-2z",
				shade: "M63.2 9.4l.7 .6 .5 1.5 2.1 13.3 .6 .6 0 2.5 .5 .5 .1 2.6 .5 .5 .1 2.1-.8 3.1 19-7.1 1-1.2 1-2.1 1.1 2.1 .4 2.6 3.2 18 0 3.1-1 2-2.2 2.1-15.9 5.8-.8 .8 3.6 19.5-.1 2.6-1.5 2.6-2.2 1.6-16.4 6.1-2.1 .6-2.5 0-12.4-2.7-2.2-1.5 12.5 2.5 2.4-1 2.7-2-3.9-22.1-3.8 3.5-1 .4-2.6 .5-1.5 1-2.6 .5-1.5 1-2.6 .4-1.5 1-4.6 1.5-2.5 0-11.9-2.6-2.7-1.6 12.4 2.3 2.6-.9 2.4-1.9-3.4-20.5 .3-.5 1.7-1.8 18.6-6.9 .3-.6-.7-1-3.8-22.1 2.1-2.1 16.4-6.1 .6-.5z",
				light: "M28.4 10.5l1.1 .5 10.2 2.1 .5 .4-.1 1.1-1.9 2.3-2.1 1-12.3-2.5-.1-1.3 1-1.6 1.2-1zM11.4 43.3l11.4 2.2 1 .6 0 .8-1.5 2.3-2.6 1.4-12.3-2.6-.2-1.1 .6-1 2.2-2.1z",
				eyes: [[
					54.5,
					53.1,
					6.1,
					15.9,
					-10
				], [
					64.5,
					49.4,
					6.1,
					15.9,
					-10
				]]
			},
			magnet: {
				body: "M71.9 4.2l1.2-.2 12.1 2.6 .5 .3 .6 1 6.2 35.6 .6 5.8-.1 5.7-.7 5.8-1.5 5.7-2.2 5.8-4.2 7.3-5.5 6.5-6.5 5-7.1 3.4-6.3 1.3-6.3 0-15.2-3.1-5.2-1.8-5.2-3-4.6-4.1-4-5.2-2.9-5.8-2.4-7.8-6.4-36.2 25-9.5 13.1 2.9 .5 .9 6.3 35.3 1.8-3.9 .5-4.7-6.3-36.1 .4-.6z",
				shade: "M86.2 9.5l.5 1 5.8 33 .6 4.7 0 5.2-.6 5.8-2.1 8.4-3.1 7.3-3.7 5.8-6.3 6.8-5.7 4.1-5.8 2.7-6.8 1.5-6.3 0-15.2-3.1-5.7-2-5.2-3.2-5.9-5.8 .1-.7 11.5 2.5 .3-3.4-1.9-13.6-5.7-32.4 1-.1 18.3-6.9 .9-.9 .4-1 6.1 35 1.6 2.1 .1 .6 4 4.7 3.2 1.1 3.6-.6 3.2-1.9 2.4-2.8 1.9-4.2 .6-3.7-6.4-36.6 19.3-7.1 .8-.8z",
				light: "M53.6 54.5l.7-.4 12 2.8 .6 1.8-.6 2.1-2.1 2.4-2.6 1-1.5 0-6.3-1.4-1.6-2.6-.2-2.1z",
				eyes: [[
					59.6,
					82.1,
					6.1,
					15.9,
					-10
				], [
					72,
					77.5,
					6.1,
					15.9,
					-10
				]]
			},
			acorn: {
				body: "M47.6 4l2.1 .6 1.3 1.5 .4 1.5-.4 5.2 .3 .3 8.8-.1 7.7 1 7.3 2.1 5.7 2.9 3.6 2.9 2.6 3 1.8 3.4 .9 3.7 0 4.1-1 3.6-1.7 2.2-3.9 3 2.9 8.3 .9 8.3-.9 8.3-2.7 7.7-4.2 6.8-2.9 3.1-3.2 2.6-6.7 3.8-3.7 1.2-4.1 .8-7.2 0-7.3-1.7-7-3.6-5.9-5.1-4.8-6.3-3.3-7.3-1.8-7.7-.1-8.3-4.5-1.5-2.6-1.7-2.6-4.1-1.1-4.1 0-4.2 1.2-4.1 2.2-4.1 2.8-3.7 5.2-4.6 6.3-3.8 7.2-3.2 8.3-2.3 .9-8.3 1.2-1.4z",
				shade: "M50.6 6.1l.1-.5 .6 2-.6 5.7 .2 2.1-1.2 .2-1.2-.7 .5-6.8zM85.8 23.7l1.7 2 1.6 3.7 .6 2.6-.1 4.1-.5 2.6-1.1 2.1-2.1 2-2.9 2.1 1.4 3.1 1.6 5.2 .9 8.8-.5 5.7-1.4 5.7-2.2 5.1-2.6 4.2-5.1 5.7-5.2 3.6-4.7 2.2-6.2 1.5-7.7 .1-5.7-1.2-6.8-3-4.6-3.2-4.2-4.2 2.1 1 2.1 .3 3.1-.3 3.1-.9 6.4-3.1 6.5-4.6 6.6-5.8 5.9-6.4 5.6-7.9 4-7.4-2.4 .4-.5 .5-1.1 0-.5 .5-1 0-.5 .5-1.1 0-.5 .5-1 0-.5 .6-1.6-.1-.5 .5-1.6 0-.5 .5-3.6 .5-.5 .5-2.1-.1-.5 .6-2.1-.1-.5 .7-3.1-.2-.5 .5-3.1 0-.5 .7-4.7-.2-.5 .7-15.6-.3 0-.3 8.3-.6 11.4-2.4 11.4-3.8 10.5-4.8 9.2-5.7 6-5.2 2.2-2.6 1.6-2.9 .5-1.7z",
				light: "M46 4.5l1.1-.1 0 .6-1.5 1.6-1.1 .2-.1-.7zM38.5 15.9l5 0 3.3 1.6 1.6 3.1 .1 3.1-.9 3.1-1.9 3.1-3.2 3.6-4 3.1-3.6 2.1-8.5 3.2-4.1 .7-4.2 .1-3.1-.5-2.6-1.5-1.1-2 .1-2.1 .5-1.5 2.1-3.7 4.1-4.6 3.7-3.1 5.1-3.2 6.3-3z",
				eyes: [[
					63.6,
					63.3,
					9.6,
					22.7,
					-11.9
				], [
					79.5,
					57.3,
					6.5,
					22.5,
					-15.5
				]]
			},
			pebbles: {
				body: "M47.3 4.5l2.7-.4 2.7 .1 13.7 3 4.3 2.1 3.3 3.4 1.3 2.2 1 2.8 2 12-.5 4.3-3.1 7.7 .2 .5 8.4 1.9 2.7 1 3.3 2.1 2.7 2.8 2.4 4.3 1.4 6.5 .1 4.4-.8 3.8-1.3 2.7-2 2.8-2.4 2.2-2.7 1.6-45.5 17-3.3 .6-3.2-.2-19.2-4.2-4.9-2.8-3.4-3.8-1.9-4.4-1.3-7.7 .2-3.2 .8-2.8 1.3-2.7 2-2.7 3.2-2.8 7.9-3.8 2.5-2.2-.4-1.6-5.4-6.1-1.8-3.8-2.3-12.5 .2-3.3 .7-2.7 2.6-4.4 2.2-2 2.2-1.4z",
				shade: "M73.2 12.2l.4 0 1.5 2.2 1.2 3.3 1.8 11.4-.2 4.4-3.3 7.6 0 1.1 .6 1.1-1.2 1.3-26.8 10.1-3.2 .5-5.8-.4-15.2-3.3-1.4-.5-3.5-3.8 .2-.3 1.6 .2 10.9 2.2 2.8-.5 4.4-2.2 5-3.8 .1-.6-1.5-8.7 4-4.5 24.2-9.2 2.4-3.8zM90.9 48.8l2.8 3.8 1 2.8 1.2 6 0 4.3-1.1 3.9-1.7 3.2-3.8 3.9-2.7 1.7-42.1 15.8-5.5 1.6-3.8 0-18-3.8-4.9-2.1-3.4-2.9 17.6 3.8 2.7-.2 3.3-1.2 4.3-2.6 4.4-3.6-.4-3.8 4.4-4.9 42.5-16 2.1-3.1 1.1-2.8 .5-3.3z",
				light: "M45.6 5.1l1.5 0-.4 .2-22.9 8.5 11.4 2.5 .6 .8 0 1.6-1.5 2.8-1.9 2.2-2.8 2.1-3.1 1.2-13.2-2.8-.1-2.2 1.2-2.2 1.7-2.2 2.7-2.2 2.2-1.1 2.2-.5 .5-.5 2.8-.6 1.6-1.1 2.7-.5 1.7-1.1 2.7-.6 1.6-1 2.8-.6 1.6-1.1 2.8-.5zM21.6 53.2l15.8 3.6 1.2 .7-.1 .9-.8 .8-3.1 1.6-1.3 3.8-3 3.8-3.3 2.5-3.3 1.4-18-3.6-.6-1.3 .6-2.2 1.6-2.7 1.7-1.8 3.8-2.8 5.5-2.2z",
				eyes: [[
					51.2,
					34.1,
					6.9,
					18.1,
					-10
				], [
					66.4,
					28.4,
					6.9,
					18.1,
					-10
				]]
			},
			cushion: {
				body: "M64.2 4.4l3.3-.4 2.8 .2 3.9 .8 2.8 1.1 2.7 1.7 2.4 2.1 1.9 2.4 1.5 2.8 1.2 3.9 7.1 40.6-.1 5-1.4 4.5-1.6 2.9-1.9 2.2-2.2 1.9-2.8 1.7-45.6 17.1-3.4 .9-3.4 .2-4.5-.7-3.4-1.2-3.3-2-2.9-2.7-2.3-3.4-1.5-3.9-7.3-41.7 .1-5 1.4-4.5 1.6-2.9 1.9-2.2 2.2-1.9 2.8-1.7z",
				shade: "M82.1 10l2.9 4 1.6 4.5 7.3 42.2-.5 5.1-1.1 3.3-1.7 2.9-4.6 4.5-3.3 1.7-46.8 17.4-5.6 .2-4-.7-3.3-1.2-3.4-2.2-1.7-1.8 .6 .4 3.3 .2 4.5-1.2 5.1-2.8 5.3-4.4-6.9-39.4 5-5.7 43.9-16.4 2.3-3.6 1.1-2.8 .5-3.6z",
				light: "M62.3 4.9l1.8 .1-43.4 16.1 1.1 .4 .8 .9 .1 1.7-1.6 3.4-2.6 3-3.4 2.7-3.4 1.5-3.4-.2-.8-.8-.2-1.2 .4-1.6 1.7-2.9 3.4-3.5 2.3-1.6 3.4-1.6 5.6-1.8 .6-.5 1.1 0 .5-.6 2.3-.5 .6-.6 1.1 0 .6-.6 2.2-.5 .6-.6 1.1 0 .6-.6 2.2-.5 .6-.6 1.1 0 .6-.5 2.2-.6 .6-.6 1.1 0 .6-.5 2.2-.6 .6-.5 1.1-.1 .6-.5 2.2-.6 .6-.5 1.1-.1 .6-.5 2.2-.6 .6-.5 1.1 0 .6-.6 2.2-.6 .6-.5 1.1 0z",
				eyes: [[
					51.1,
					57.2,
					8.4,
					22.1,
					-10
				], [
					69.9,
					50.1,
					8.4,
					22.1,
					-10
				]]
			},
			ring: {
				body: "M48.1 4.3l8-.1 7.8 1.8 7.3 3.5 6.7 5.4 5.2 6.7 4.1 8.3 2.3 8.9 .7 9-1 9.5-2.5 8.9-4.1 8.3-5.3 7.3-6.6 6.1-7.3 4.5-7.8 2.7-8.4 .9-7.2-.8-7.3-2.5-6.7-4.1-5.6-5.3-4.5-6.5-3.5-7.8-2-8.4-.6-8.4 .9-8.9 2.2-8.4 3.5-7.8 4.9-7.2 5.8-6.1 6.3-4.5 7.1-3.3zM50.5 33.8l2.3-.3 1.7 .4 1.6 1.1 2 2.2 1.3 2.8 .8 2.7 .4 3.4-.1 3.3-1.4 6.2-3 5.6-2.2 2.4-2.2 1.6-2.3 1-2.2 .3-1.7-.4-1.6-1.1-2.8-3.7-1.5-5.2-.1-5.5 1.2-5.6 2.4-5 3.6-4z",
				shade: "M76.2 14.9l1.1-.5 3.4 3.8 2.8 3.9 2.3 4.5 1.6 3.9 1.6 5.6 1.1 8.3-.4 10.1-1.3 6.1-2.6 7.8-4.6 8.3-4.4 5.6-6.2 5.7-6.1 3.8-7.2 2.9-6.2 1.1-7.8-.1-7.2-1.7-3.9-1.6-4-2.2-5.5-4.5-2.8-3.4 1.7-.6 2.4-2.1 2-2.8 1.2-2.8 1.2-5 1.1-13.4 1.4-7.8 2.5-7.8 3.8-7.3 3.3-4.5 3.4-3.4 3.9-3.1 4.4-2.6 3.9-1.5 4.5-1.1 12.3-.9zM50.5 33.8l.6-.3 2.8 0 1.6 .9 2.7 2.8 3 1.4 3.3 .5 6.1 .2 3.9 .9 1.7 1 1.7 1.6 2.1 4.4 .7 4.5-.3 5-1.2 5-1.9 4.5-2.8 4.2-3.3 3.6-3.9 2.8-3.9 1.7-3.4 .6-3.3-.1-3.4-1.1-2.5-1.7-2.5-3-3.6-7-2.9-3.4-2.1-5-.6-5.6 .6-4.4 1-3.4 2.3-4.4 1.4-2.1 2.3-2.2 2.7-1.7z",
				light: "M41.1 5.9l.5 .1 .2 .5-.3 .6-12.4 13.3-13.1 18.1-2.3 2.1-1.1 0-.2-1.2 .2-2.8 1.6-5 4.6-8.3 3.9-5.1 4.4-4.4 4.5-3.4 5-2.8zM60.5 53.3l1.2-.3 1.1 .6 1.1 1.3 .8 1.8-.2 3.3-1.5 2.8-2 1.7-2.6 1-7.3 .2 2.2-1.4 2.6-2.6z",
				eyes: [[
					56.2,
					84.6,
					5.3,
					13.3,
					-6.8
				], [
					71.7,
					78.8,
					5.1,
					13.4,
					-6.5
				]]
			},
			gem: {
				body: "M57 9.3l2.9-.4 14.9 3.5 19.6 14.1 1 1.4 .6 1.6-.5 2.6-27.1 56.5-1.6 1.8-2.1 .7-15.9-3.4-42.9-30.7-1.3-1.6-.6-1.6 .5-2.6 12-25.2 1.1-1.5 1.5-1z",
				shade: "M75.7 14.6l.1-.4 .6 .2 16.9 12.3 1.1 .7 .5-.2 .5 .7 .6 2.6-.5 1.6-26.4 55.1-1.2 2.1-1.1 1.1-1.6 .6-2.1 0-14.3-3.3-42.8-30.7 1.5-.2 11.6 2.5 2.2-.7 2.8-2.6 11.9-24.9 .6-.8 38.2-14.2z",
				light: "M19.1 23.6l1.1-.4 .5 .5 11.7 2.2 1 .9-.2 .5-1.8 2.7-11.7 24.4-1.6 .6-13.3-2.8-.5-.5 12.1-25.4 1.2-1.7z",
				eyes: [[
					51.4,
					42.9,
					6.7,
					17.7,
					-10
				], [
					66.1,
					37.4,
					6.7,
					17.7,
					-10
				]]
			}
		};
		/** Inks (light) for characters; gradients paint from the top left to the bottom right. */
		const INKS = {
			deepseek: "#4D6BFE",
			black: "#000000",
			brown: "#9A6B44",
			red: "#FF3E51",
			orange: "#FF6B1A",
			yellow: "#FFB020",
			green: "#10B981",
			cyan: "#06B6D4",
			blue: "#2563EB",
			violet: "#8B5CF6",
			magenta: "#F43F85",
			gray: "#8A8F98",
			aurora: "#00B8D4"
		};
		const GRADIENTS = { aurora: [
			[0, "#A4FFB0"],
			[.42, "#00F0E4"],
			[1, "#2E9EF7"]
		] };
		/** A Bot with no choice gets one of the friendliest seven; the whale stays the supervisor's. */
		const DEFAULT_SHAPES = [
			"star",
			"moon",
			"gumdrop",
			"peanut",
			"bunny",
			"kitty",
			"acorn"
		];
		const DEFAULT_COLORS = [
			"red",
			"orange",
			"yellow",
			"green",
			"cyan",
			"blue",
			"violet",
			"magenta"
		];
		const FALLBACK_SHAPE = "gumdrop";
		/** The supervisor's own look: DS Bot's Main Bot whale. */
		const SUPERVISOR_LOOK = Object.freeze({
			shape: "whale",
			color: "deepseek"
		});
		/** FNV-1a, as DS Bot hashes a Bot id. */
		function fnv1a(text) {
			let value = 2166136261;
			for (let index = 0; index < text.length; index += 1) value = Math.imul(value ^ text.charCodeAt(index), 16777619);
			return value >>> 0;
		}
		function defaultColor(id) {
			const t = fnv1a(id) + 1831565813 | 0;
			let n = Math.imul(t ^ t >>> 15, 1 | t);
			n = n + Math.imul(n ^ n >>> 7, 61 | n) ^ n;
			return DEFAULT_COLORS[Math.floor(((n ^ n >>> 14) >>> 0) / 4294967296 * DEFAULT_COLORS.length)];
		}
		function defaultShape(id) {
			let value = fnv1a(id) | 0;
			value = Math.imul(value ^ value >>> 16, 73244475);
			value = Math.imul(value ^ value >>> 13, 3266489909);
			return DEFAULT_SHAPES[((value ^ value >>> 16) >>> 0) % DEFAULT_SHAPES.length];
		}
		/** A Bot's look from its id: the same shape and color everywhere it shows. */
		const lookOf = (id) => ({
			shape: defaultShape(id),
			color: defaultColor(id)
		});
		const hasShape = (id) => Object.hasOwn(CHARACTERS, id);
		const shapeOf = (id) => CHARACTERS[hasShape(id) ? id : FALLBACK_SHAPE];
		const eyeMarkup = ([cx, cy, w, h, tilt]) => `<g transform="translate(${cx} ${cy}) rotate(${tilt})"><rect class="dt-bm-eye" x="${-w / 2}" y="${-h / 2}" width="${w}" height="${h}" rx="${w / 2}"/></g>`;
		/** Each mark's own mask id stands in for this: a duplicate id resolves to its first copy, which stops painting once it unmounts. */
		const MASK_ID = "%MASK%";
		const cache = /* @__PURE__ */ new Map();
		/** The SVG inside a 100-unit view box for a shape in a color, with `MASK_ID` for the mark to replace. */
		function characterMarkup(shape, color) {
			const key = `${shape}|${color}`;
			const known = cache.get(key);
			if (known !== void 0) return known;
			const def = shapeOf(shape);
			const eyes = `<g class="dt-bm-eyes" fill="#000">${def.eyes.map(eyeMarkup).join("")}</g>`;
			const stops = GRADIENTS[color];
			const gradient = stops ? `<linearGradient id="${MASK_ID}g" gradientUnits="userSpaceOnUse" x1="18" y1="10" x2="78" y2="92">${stops.map(([offset, value]) => `<stop offset="${offset}" stop-color="${value}"/>`).join("")}</linearGradient>` : "";
			const paint = stops ? `url(#${MASK_ID}g)` : INKS[color] ?? INKS.gray;
			const layers = [...(def.paints ?? []).map(([d, fill, opacity]) => `<path d="${d}" fill="${fill}" fill-opacity="${opacity}"/>`), `<path d="${def.shade}" fill="#000" fill-opacity=".07"/>`].join("");
			const body = `<g mask="url(#${MASK_ID})"><g fill-rule="evenodd"><path d="${def.body}" fill="${paint}"/>${layers}</g></g>`;
			const markup = `<defs>${gradient}<mask id="${MASK_ID}" maskUnits="userSpaceOnUse" x="-100" y="-100" width="300" height="300"><rect x="-100" y="-100" width="300" height="300" fill="#fff"/>${eyes}</mask></defs><g class="dt-bm-b">${body}</g>`;
			cache.set(key, markup);
			return markup;
		}
		//#endregion
		//#region src/client/mark.tsx
		/**
		* VsSaros addition (plan C): a Bot's mark, after DS Bot's (ds-bot/src/client/mark.js, Apache License 2.0; see NOTICE). Its
		* character moves for what the Bot does: thinks, searches, works, sends, waits for teammates, hops when it waits for the
		* person, and settles with a squash when its step ends. Marks in lists (`live`) also blink and fidget at rest, each Bot at
		* its own moment; marks inside the conversation stay still so a long chat does not run dozens of animations.
		*/
		const FIDGETS = [
			"hop",
			"sway",
			"stretch",
			"look"
		];
		/** What a tool call looks like on a mark: searching for reads and lookups, sending for messages and reports, working otherwise. */
		function toolState(name) {
			if (/^(orchestrator_step_report|orchestrator_step_message|agent_message|superagent_submit)$/.test(name)) return "sending";
			return /search|fetch|browse|read|grep|glob|list|recall|web/i.test(name) ? "searching" : "working";
		}
		/** A team step's mark: hops while it waits for the person, moves for its latest tool call while it runs, waits for its upstream. */
		function stepMarkState(step) {
			if (step.approval || step.state === "blocked") return "alert";
			if (step.state === "running") return step.doing ? toolState(step.doing.tool) : "thinking";
			if (step.state === "pending") return "waiting";
			return "idle";
		}
		let serial = 0;
		/** A mark settles with a short squash when its Bot stops working. */
		function useSettled(state) {
			const previous = (0, react.useRef)(state);
			const [settled, setSettled] = (0, react.useState)(false);
			(0, react.useEffect)(() => {
				const was = previous.current;
				previous.current = state;
				if (state !== "idle") {
					setSettled(false);
					return;
				}
				if (was === "idle" || was === "alert" || was === "waiting") return void 0;
				setSettled(true);
				const timer = setTimeout(() => setSettled(false), 1800);
				return () => clearTimeout(timer);
			}, [state]);
			return settled;
		}
		/** A Bot's character with its state's motion, and a badge: "?" while it waits for the person, a green dot while it works. */
		function BotMark({ id, name, size = 28, state = "idle", live = false, look, faded }) {
			const settled = useSettled(state);
			const mask = (0, react.useRef)("");
			if (mask.current === "") mask.current = `dt-bm-${serial += 1}`;
			const { shape, color } = look ?? (id === "superagent" ? SUPERVISOR_LOOK : lookOf(id));
			const shown = settled ? "done" : state;
			const badge = live && state === "alert" ? "alert" : live && state !== "idle" && state !== "waiting" && state !== "done" ? "working" : void 0;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
				className: "dt-bm",
				"data-shape": shape,
				"data-state": shown,
				"data-live": live || void 0,
				"data-faded": faded || void 0,
				"data-fidget": live ? FIDGETS[fnv1a(`${id}:fidget`) % FIDGETS.length] : void 0,
				role: name ? "img" : void 0,
				"aria-label": name,
				"aria-hidden": name ? void 0 : true,
				style: {
					width: size,
					height: size,
					["--dt-bm-size"]: `${size}px`,
					...live ? {
						["--dt-bm-delay"]: `${-(fnv1a(id) % 5e3) / 1e3}s`,
						["--dt-bm-fidget-delay"]: `${-(fnv1a(`${id}:when`) % 9e3) / 1e3}s`
					} : {}
				},
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("svg", {
						viewBox: "0 0 100 100",
						dangerouslySetInnerHTML: { __html: characterMarkup(shape, color).replaceAll(MASK_ID, mask.current) }
					}),
					badge === "alert" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "dt-bm-badge",
						"data-kind": "alert",
						"aria-hidden": "true",
						children: "?"
					}),
					badge === "working" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "dt-bm-badge",
						"data-kind": "working",
						"aria-hidden": "true"
					})
				]
			});
		}
		//#endregion
		//#region src/client/work.tsx
		/**
		* VsSaros addition (superagent runtime UI, plan C): the supervisor's teams at work. The side panel shows what waits for the
		* person (a step's request to reach beyond its directory: allow once, allow and remember, or refuse) and each team's
		* members, what they do now and for how long, with a stop button each; a small flow chart opens the Workbench tab, which
		* shows a team's steps as a dependency graph (after TeamFlow's: status bar, glow and pulse on what runs, one card per step
		* with its attempts), a board by state, or a list, and a step's details beside them.
		*/
		const STEP_TONE = {
			pending: "neutral",
			running: "info",
			ready: "success",
			blocked: "warning",
			failed: "danger",
			skipped: "neutral",
			stopped: "neutral"
		};
		const FINISHED = [
			"ready",
			"failed",
			"skipped",
			"stopped"
		];
		const WorkContext = (0, react.createContext)(void 0);
		function useWork() {
			const value = (0, react.useContext)(WorkContext);
			if (!value) throw new Error("dsh-superagent team work used outside its provider");
			return value;
		}
		const settled = async () => {};
		/** Reads the team work again after an action, where a provider holds it; elsewhere the change stream brings it. */
		const useReload = () => (0, react.useContext)(WorkContext)?.reload ?? settled;
		/**
		* Keeps the teams at work current: read again as the change stream reports steps (their Bots' work and requests) or tickets
		* (proposals) changed; polled every 2 seconds while a step runs and the stream is down, else every 5.
		*/
		function WorkProvider({ children }) {
			const { call } = usePanel();
			const [busy, setBusy] = (0, react.useState)(false);
			const steps = useLive(() => call("GET team/steps"), [busy], ["steps", "tickets"], busy ? 2e3 : 5e3);
			const proposals = useLive(() => call("GET team/proposals"), [], ["tickets"], 5e3);
			const running = !!steps.data?.tickets.some((team) => team.steps.some((step) => step.state === "running"));
			(0, react.useEffect)(() => {
				setBusy(running);
			}, [running]);
			const value = (0, react.useMemo)(() => ({
				teams: steps.data?.tickets ?? [],
				approvals: steps.data?.approvals ?? [],
				proposals: proposals.data?.waiting,
				loaded: !!steps.data && !!proposals.data,
				reload: async () => {
					await Promise.all([steps.reload(), proposals.reload()]);
				}
			}), [
				steps.data,
				proposals.data,
				steps.reload,
				proposals.reload
			]);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(WorkContext.Provider, {
				value,
				children
			});
		}
		const PHRASES = [
			[/^(read|grep|glob|find|search|ls|list)/i, "work.doing.look"],
			[/^(write|edit|patch|apply)/i, "work.doing.write"],
			[/^(pwsh|shell|bash|exec|run|powershell|cmd)/i, "work.doing.shell"],
			[/^web/i, "work.doing.web"],
			[/^subagent/i, "work.doing.subagent"],
			[/^todo/i, "work.doing.plan"],
			[/^orchestrator_step_report$/, "work.doing.report"]
		];
		/** What a Bot does, as a short phrase: its own description, else the kind of tool and what it acts on. */
		function doingText(t, doing) {
			if (!doing) return t("work.doing.think");
			if (doing.note) return doing.note;
			const key = PHRASES.find(([pattern]) => pattern.test(doing.tool))?.[1];
			const phrase = key ? t(key) : t("work.doing.tool", { tool: doing.tool });
			return doing.target ? `${phrase} · ${doing.target}` : phrase;
		}
		/** Seconds since `since`, as DeepSeek-Bot's member rows count them: 12s, 3m 4s, 1h 2m. */
		function elapsedLabel(since, now = Date.now()) {
			const seconds = Math.max(0, Math.floor((now - Date.parse(since)) / 1e3));
			const h = Math.floor(seconds / 3600), m = Math.floor(seconds % 3600 / 60), s = seconds % 60;
			return h ? `${h}h ${m}m` : m ? `${m}m ${s}s` : `${s}s`;
		}
		function Elapsed({ since }) {
			const [, tick] = (0, react.useState)(0);
			(0, react.useEffect)(() => {
				const timer = setInterval(() => tick((value) => value + 1), 1e3);
				return () => clearInterval(timer);
			}, []);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				className: "dt-elapsed",
				children: elapsedLabel(since)
			});
		}
		const ENDED_UNFINISHED = [
			"failed",
			"skipped",
			"stopped"
		];
		/**
		* The teams waiting for the person to agree, each with its members, steps and the agree and refuse buttons; shown in the
		* Overview and, in a VsSaros workbench, above the desk's conversation (2026-11-05: the person must see a proposal to agree).
		*/
		function StaffingList({ teams }) {
			const { t, call } = usePanel();
			const reload = useReload();
			const agree = useAction((input) => call("POST tickets/:id/team/approve", {
				id: input.id,
				body: { version: input.version }
			}), { reload });
			const refuse = useAction((id) => call("POST tickets/:id/team/reject", {
				id,
				body: {}
			}), { reload });
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("ul", {
				className: "dt-list dt-cards",
				"data-testid": "team-staffing",
				children: teams.map(({ ticket, proposal }) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", {
					className: "dt-row dt-link",
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dt-row-main",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "dt-row-title",
							children: [
								ticket.title,
								" ",
								proposal ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									className: "dt-tag",
									"data-tone": "warning",
									children: ["v", proposal.version]
								}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "dt-tag",
									"data-tone": "neutral",
									children: t("team.staffingProposing")
								})
							]
						}), proposal && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "dt-row-meta",
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: proposal.roles.map((role) => `${role.bot?.name ?? role.draft?.name ?? role.key}${role.draft ? t("team.staffingNew") : ""}`).join("、") }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: proposal.steps.map((step) => step.title).join(" → ") }),
								(proposal.risk.newBots > 0 || proposal.risk.writeSteps > 0 || proposal.risk.highRiskTools.length > 0) && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "dt-tag",
									"data-tone": "warning",
									children: t("team.risky")
								})
							]
						})]
					}), proposal && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dt-row-actions",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Button, {
							variant: "primary",
							size: "sm",
							disabled: agree.busy,
							onClick: () => {
								agree.run({
									id: ticket.id,
									version: proposal.version
								});
							},
							children: t("team.staffingAgree")
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ConfirmButton, {
							variant: "outline",
							label: t("team.staffingRefuse"),
							title: t("team.staffingRefuseTitle"),
							message: t("team.staffingRefuseConfirm", { title: ticket.title }),
							onConfirm: async () => {
								await refuse.run(ticket.id);
							}
						})]
					})]
				}, ticket.id))
			});
		}
		/** A step's request to reach beyond its directory, waiting for the person. */
		function ApprovalCard({ approval }) {
			const { t, call } = usePanel();
			const answer = useAction((choice) => call("POST steps/approvals/:id/answer", {
				id: approval.id,
				body: { choice }
			}), { reload: useReload() });
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "dt-approval",
				"data-testid": "step-approval",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dt-approval-head",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(BotMark, {
								id: approval.bot.id,
								size: 22,
								state: "alert"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("b", { children: t("work.approvalTitle", {
								bot: approval.bot.name,
								step: approval.step
							}) }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "dt-approval-ticket",
								children: approval.ticketTitle
							})
						]
					}),
					approval.detail.code && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", {
						className: "dt-approval-code",
						children: approval.detail.code
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "dt-approval-why",
						children: approval.detail.text ?? approval.reason
					}),
					approval.feishu && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "dt-approval-why",
						children: t("work.approvalFeishu", { code: approval.code })
					}),
					approval.restored && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "dt-approval-why",
						children: t("work.approvalRestored")
					}),
					approval.expiresAt && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "dt-approval-why",
						children: t("work.approvalExpires", { time: new Date(approval.expiresAt).toLocaleTimeString([], {
							hour: "2-digit",
							minute: "2-digit"
						}) })
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dt-row-actions",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Button, {
								variant: "outline",
								size: "sm",
								disabled: answer.busy,
								onClick: () => {
									answer.run("reject");
								},
								children: t("work.reject")
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Button, {
								variant: "primary",
								size: "sm",
								disabled: answer.busy,
								onClick: () => {
									answer.run("allow");
								},
								children: t("work.allow")
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Button, {
								variant: "outline",
								size: "sm",
								disabled: answer.busy,
								onClick: () => {
									answer.run("remember");
								},
								children: t("work.remember")
							})
						]
					})
				]
			});
		}
		/** One line per step of a team: its Bot, what it does now and for how long, and a stop button while it is unfinished. */
		function StepMembers({ team }) {
			const { t, call } = usePanel();
			const reload = useReload();
			const stop = useAction((key) => call("POST tickets/:id/steps/:key/stop", {
				id: team.ticket.id,
				key
			}), { reload });
			const unsandboxed = useAction((key) => call("POST tickets/:id/steps/:key/unsandboxed", {
				id: team.ticket.id,
				key
			}), { reload });
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("ul", {
				className: "dt-members",
				children: team.steps.map((step) => {
					const running = step.state === "running";
					const line = step.approval ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "dt-member-alert",
						children: t("work.waitsForYou")
					}) : step.needs ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "dt-member-alert",
						children: t(step.needs === "sandbox" ? "work.needsSandbox" : "work.needsPermission")
					}) : running ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "dt-shimmer",
						children: doingText(t, step.doing)
					}) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: [t(`team.step.${step.state}`), step.state === "ready" && step.report ? ` · ${step.report}` : ""] });
					return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", {
						className: "dt-member",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(BotMark, {
								id: step.botId,
								name: step.bot,
								size: 30,
								state: stepMarkState(step),
								live: true,
								faded: ENDED_UNFINISHED.includes(step.state)
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "dt-member-main",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "dt-member-name",
									children: [
										step.bot,
										" ",
										/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
											className: "dt-member-step",
											children: [
												step.key,
												" ",
												step.title
											]
										}),
										step.access === "write" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: "dt-tag",
											"data-tone": "outline",
											children: t("work.writes")
										}),
										step.unsandboxed && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: "dt-tag",
											"data-tone": "warning",
											title: t("work.unsandboxedHint"),
											children: t("work.unsandboxed")
										})
									]
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "dt-member-line",
									children: [line, running && step.since && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [" · ", /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Elapsed, { since: step.since })] })]
								})]
							}),
							step.needs && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Button, {
								variant: "outline",
								size: "sm",
								disabled: unsandboxed.busy,
								title: t("work.unsandboxedHint"),
								onClick: () => {
									unsandboxed.run(step.key);
								},
								children: t("work.allowUnsandboxed")
							}),
							!FINISHED.includes(step.state) && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Button, {
								variant: "outline",
								size: "sm",
								disabled: stop.busy,
								"aria-label": t("work.stopStep", { step: step.key }),
								onClick: () => {
									stop.run(step.key);
								},
								children: t("work.stop")
							})
						]
					}, step.key);
				})
			});
		}
		/** Each step's column (the longest chain of steps before it) and row within its column. */
		function layoutSteps(steps) {
			const col = /* @__PURE__ */ new Map();
			const colOf = (key, depth = 0) => {
				if (col.has(key)) return col.get(key);
				const step = steps.find((item) => item.key === key);
				const value = !step || depth > steps.length || !step.after.length ? 0 : 1 + Math.max(...step.after.map((before) => colOf(before, depth + 1)));
				col.set(key, value);
				return value;
			};
			const rows = /* @__PURE__ */ new Map(), place = /* @__PURE__ */ new Map();
			for (const step of steps) {
				const c = colOf(step.key), r = rows.get(c) ?? 0;
				rows.set(c, r + 1);
				place.set(step.key, {
					col: c,
					row: r
				});
			}
			return place;
		}
		const tone = (step) => step.approval ? "alert" : step.state;
		/** A team's flow at a glance; clicking it opens the Workbench tab, where there is one. */
		function MiniFlow({ team, onOpen }) {
			const { t } = usePanel();
			const place = layoutSteps(team.steps), W = 52, H = 22;
			const x = (key) => 6 + place.get(key).col * 82, y = (key) => 6 + place.get(key).row * 32;
			const width = Math.max(...team.steps.map((step) => x(step.key))) + W + 6, height = Math.max(...team.steps.map((step) => y(step.key))) + H + 6;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(onOpen ? "button" : "div", {
				...onOpen ? {
					type: "button",
					onClick: onOpen,
					"aria-label": t("work.openFlow", { title: team.ticket.title })
				} : {
					role: "img",
					"aria-label": team.ticket.title
				},
				className: "dt-mini-flow",
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("svg", {
					width,
					height,
					viewBox: `0 0 ${width} ${height}`,
					"aria-hidden": "true",
					children: [team.steps.flatMap((step) => step.after.filter((before) => place.has(before)).map((before) => {
						const x1 = x(before) + W, y1 = y(before) + H / 2, x2 = x(step.key), y2 = y(step.key) + H / 2, mid = (x1 + x2) / 2;
						return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
							className: "dt-flow-line",
							"data-state": tone(step),
							d: `M${x1} ${y1} C${mid} ${y1} ${mid} ${y2} ${x2} ${y2}`
						}, `${before}-${step.key}`);
					})), team.steps.map((step) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("g", {
						className: "dt-mini-node",
						"data-state": tone(step),
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("rect", {
							x: x(step.key),
							y: y(step.key),
							width: W,
							height: H,
							rx: 6
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("text", {
							x: x(step.key) + W / 2,
							y: y(step.key) + 15,
							textAnchor: "middle",
							children: [step.key, step.attempts > 1 ? " ↻" : ""]
						})]
					}, step.key))]
				})
			});
		}
		const NODE_W = 236;
		const NODE_H = 86;
		const PAD = 28;
		function FlowView({ team, selected, onSelect }) {
			const { t } = usePanel();
			const place = layoutSteps(team.steps);
			const [view, setView] = (0, react.useState)({
				x: 0,
				y: 0,
				zoom: 1
			});
			const drag = (0, react.useRef)(void 0);
			const left = (key) => PAD + place.get(key).col * 340, top = (key) => PAD + place.get(key).row * 114;
			const width = Math.max(...team.steps.map((step) => left(step.key))) + NODE_W + PAD;
			const height = Math.max(...team.steps.map((step) => top(step.key))) + NODE_H + PAD;
			const zoomTo = (factor) => setView((current) => ({
				...current,
				zoom: Math.min(1.65, Math.max(.5, current.zoom * factor))
			}));
			const wheel = (event) => {
				if (event.ctrlKey || event.metaKey) {
					event.preventDefault();
					zoomTo(event.deltaY < 0 ? 1.12 : .89);
				}
			};
			const down = (event) => {
				if (event.target.closest(".dt-flow-node, .dt-flow-zoom")) return;
				drag.current = {
					x: event.clientX,
					y: event.clientY,
					from: view
				};
				event.currentTarget.setPointerCapture?.(event.pointerId);
			};
			const move = (event) => {
				const start = drag.current;
				if (start) setView({
					...start.from,
					x: start.from.x + event.clientX - start.x,
					y: start.from.y + event.clientY - start.y
				});
			};
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "dt-graph",
				role: "group",
				"aria-label": t("work.view.flow"),
				onWheel: wheel,
				onPointerDown: down,
				onPointerMove: move,
				onPointerUp: () => {
					drag.current = void 0;
				},
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "dt-flow-zoom",
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							"aria-label": t("work.zoomOut"),
							onClick: () => zoomTo(.86),
							children: "−"
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: [Math.round(view.zoom * 100), "%"] }),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							"aria-label": t("work.zoomIn"),
							onClick: () => zoomTo(1.16),
							children: "+"
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							"aria-label": t("work.fit"),
							onClick: () => setView({
								x: 0,
								y: 0,
								zoom: 1
							}),
							children: "⤢"
						})
					]
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "dt-flow-canvas",
					style: {
						width,
						height,
						transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})`
					},
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("svg", {
						className: "dt-flow-lines",
						width,
						height,
						"aria-hidden": "true",
						children: team.steps.flatMap((step) => step.after.filter((before) => place.has(before)).map((before) => {
							const x1 = left(before) + NODE_W, y1 = top(before) + NODE_H / 2, x2 = left(step.key), y2 = top(step.key) + NODE_H / 2, mid = (x1 + x2) / 2;
							const d = `M${x1} ${y1} C${mid} ${y1} ${mid} ${y2} ${x2} ${y2}`;
							return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("g", {
								"data-state": tone(step),
								className: "dt-flow-edge",
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
										className: "dt-flow-glow",
										d
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
										className: "dt-flow-line",
										d
									}),
									step.state === "running" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
										className: "dt-flow-moving",
										d
									})
								]
							}, `${before}-${step.key}`);
						}))
					}), team.steps.map((step) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
						type: "button",
						className: "dt-flow-node",
						"data-state": tone(step),
						"aria-pressed": selected === step.key,
						style: {
							left: left(step.key),
							top: top(step.key),
							width: NODE_W,
							height: NODE_H
						},
						onClick: () => onSelect(step.key),
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								className: "dt-flow-node-title",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "dt-flow-key",
									children: step.key
								}), step.title]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								className: "dt-flow-node-who",
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)(BotMark, {
										id: step.botId,
										size: 22,
										state: stepMarkState(step),
										faded: ENDED_UNFINISHED.includes(step.state)
									}),
									step.bot,
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: "dt-tag",
										"data-tone": step.approval ? "warning" : STEP_TONE[step.state],
										children: step.approval ? t("work.waitsForYou") : t(`team.step.${step.state}`)
									})
								]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								className: "dt-flow-node-meta",
								children: [step.access === "write" ? t("work.writes") : t("work.reads"), step.turns ? ` · ${t("work.turns", { turns: String(step.turns) })}` : ""]
							}),
							step.attempts > 1 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								className: "dt-flow-retry",
								children: ["↻", step.attempts]
							}),
							step.state === "running" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "dt-flow-bar",
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("i", {})
							})
						]
					}, step.key))]
				})]
			});
		}
		const COLUMNS = [
			{
				key: "pending",
				states: ["pending"]
			},
			{
				key: "running",
				states: ["running"]
			},
			{
				key: "blocked",
				states: ["blocked"]
			},
			{
				key: "ready",
				states: ["ready"]
			},
			{
				key: "ended",
				states: [
					"failed",
					"skipped",
					"stopped"
				]
			}
		];
		function BoardView({ team, onSelect }) {
			const { t } = usePanel();
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: "dt-board",
				children: COLUMNS.map((column) => {
					const items = team.steps.filter((step) => column.key === "blocked" ? step.state === "blocked" || !!step.approval : column.key === "running" ? step.state === "running" && !step.approval : column.states.includes(step.state));
					return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
						className: "dt-board-col",
						"aria-label": t(`work.col.${column.key}`),
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("h3", { children: [t(`work.col.${column.key}`), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: items.length })] }), items.map((step) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
							type: "button",
							className: "dt-board-card",
							"data-state": tone(step),
							onClick: () => onSelect(step.key),
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									className: "dt-flow-key",
									children: [step.key, step.attempts > 1 ? ` ↻${step.attempts}` : ""]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("b", { children: step.title }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									className: "dt-board-who",
									children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)(BotMark, {
											id: step.botId,
											size: 16,
											faded: ENDED_UNFINISHED.includes(step.state)
										}),
										step.bot,
										" · ",
										step.access === "write" ? t("work.writes") : t("work.reads")
									]
								})
							]
						}, step.key))]
					}, column.key);
				})
			});
		}
		function ListView({ team, onSelect }) {
			const { t } = usePanel();
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("table", {
				className: "dt-step-table",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("thead", { children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("tr", { children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", { children: t("work.col.step") }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", { children: t("work.col.bot") }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", { children: t("work.col.after") }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", { children: t("work.col.access") }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", { children: t("work.col.state") }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", { children: t("work.col.turns") })
				] }) }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("tbody", { children: team.steps.map((step) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("tr", {
					tabIndex: 0,
					onClick: () => onSelect(step.key),
					onKeyDown: (event) => {
						if (event.key === "Enter") onSelect(step.key);
					},
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("td", { children: [
							step.key,
							" ",
							step.title,
							step.attempts > 1 ? ` ↻${step.attempts}` : ""
						] }),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", { children: step.bot }),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", { children: step.after.join("、") || "—" }),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", { children: step.access === "write" ? t("work.writes") : t("work.reads") }),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", { children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "dt-tag",
							"data-tone": step.approval ? "warning" : STEP_TONE[step.state],
							children: step.approval ? t("work.waitsForYou") : t(`team.step.${step.state}`)
						}) }),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", { children: step.turns || "—" })
					]
				}, step.key)) })]
			});
		}
		function StepDetail({ team, step, onClose }) {
			const { t, call, openSession, notify } = usePanel();
			const { approvals } = useWork();
			const stop = useAction(() => call("POST tickets/:id/steps/:key/stop", {
				id: team.ticket.id,
				key: step.key
			}), { reload: useReload() });
			const approval = approvals.find((item) => item.id === step.approval);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("aside", {
				className: "dt-step-detail",
				"aria-label": t("work.detail", { step: step.key }),
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dt-step-detail-head",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("b", { children: [
								step.key,
								" ",
								step.title
							] }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "dt-tag",
								"data-tone": STEP_TONE[step.state],
								children: t(`team.step.${step.state}`)
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Button, {
								variant: "ghost",
								size: "sm",
								icon: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Icon, { name: "close" }),
								"aria-label": t("close"),
								onClick: onClose
							})
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("dl", {
						className: "dt-step-facts",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("dt", { children: t("work.col.bot") }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("dd", { children: step.bot }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("dt", { children: t("work.col.after") }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("dd", { children: step.after.join("、") || "—" }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("dt", { children: t("work.col.access") }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("dd", { children: [step.access === "write" ? t("work.writes") : t("work.reads"), step.unsandboxed ? ` · ${t("work.unsandboxed")}` : ""] }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("dt", { children: t("work.col.turns") }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("dd", { children: step.turns }),
							step.state === "running" && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("dt", { children: t("work.now") }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("dd", { children: [doingText(t, step.doing), step.since && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [" · ", /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Elapsed, { since: step.since })] })] })] })
						]
					}),
					approval && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ApprovalCard, { approval }),
					(step.failures?.length ?? 0) > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dt-step-attempts",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("b", { children: t("work.attempts") }),
							step.failures.map((failure, index) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "dt-tag",
									"data-tone": "danger",
									children: t("work.attempt", { n: String(index + 1) })
								}),
								" ",
								failure
							] }, index)),
							step.attempts > step.failures.length && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "dt-tag",
									"data-tone": STEP_TONE[step.state],
									children: t("work.attempt", { n: String(step.attempts) })
								}),
								" ",
								t(`team.step.${step.state}`)
							] })
						]
					}),
					step.report && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: "dt-step-report",
						children: step.report
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dt-row-actions",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Button, {
							variant: "outline",
							size: "sm",
							icon: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Icon, {
								name: "session",
								size: 14
							}),
							onClick: () => {
								openSession(`step-${team.ticket.id}-${step.key}`).catch((failure) => notify(errorText(failure)));
							},
							children: t("work.openSession")
						}), !FINISHED.includes(step.state) && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Button, {
							variant: "outline",
							size: "sm",
							disabled: stop.busy,
							onClick: () => {
								stop.run();
							},
							children: t("work.stop")
						})]
					})
				]
			});
		}
		const VIEW_KEY = "dsh-superagent/work-view";
		/** The team's steps as a flow, a board or a list (2026-11-09: hosted inside the Execution tab).
		*  `embedded` = 执行页内嵌：那一页已有 <GroupRuns compact />，这里不再重复轮询群进度。 */
		function WorkPage({ ticketId, embedded = false }) {
			const { t } = usePanel();
			const { teams, approvals, loaded } = useWork();
			const [chosen, setChosen] = (0, react.useState)(ticketId);
			const [view, setViewState] = (0, react.useState)(() => [
				"flow",
				"board",
				"list"
			].find((item) => item === sessionStorage.getItem(VIEW_KEY)) ?? "flow");
			const setView = (next) => {
				setViewState(next);
				try {
					sessionStorage.setItem(VIEW_KEY, next);
				} catch {}
			};
			const [selected, setSelected] = (0, react.useState)();
			const team = teams.find((item) => item.ticket.id === chosen) ?? teams[0];
			const groupRuns = embedded ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(GroupRuns, {});
			if (!loaded) return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [groupRuns, /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Hint, { children: t("loading") })] });
			if (!team) return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "dt-work",
				children: [groupRuns, /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Hint, { children: t("work.empty") })]
			});
			const step = team.steps.find((item) => item.key === selected);
			const waiting = approvals.filter((item) => item.ticketId === team.ticket.id);
			const done = team.steps.filter((item) => item.state === "ready").length;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "dt-work",
				children: [
					groupRuns,
					teams.length > 1 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "dt-work-teams",
						role: "group",
						"aria-label": t("work.teams"),
						children: teams.map((item) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: "dt-work-team",
							"aria-pressed": item.ticket.id === team.ticket.id,
							onClick: () => {
								setChosen(item.ticket.id);
								setSelected(void 0);
							},
							children: item.ticket.title
						}, item.ticket.id))
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dt-work-bar",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "dt-work-dot",
								"data-live": team.steps.some((item) => item.state === "running") || void 0
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("b", { children: team.ticket.title }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "dt-hint",
								children: t("team.stepsDone", {
									done: String(done),
									total: String(team.steps.length)
								})
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(SegmentedTabs, {
								className: "dt-work-views",
								label: t("work.views"),
								value: view,
								onChange: (next) => setView(next),
								items: [
									"flow",
									"board",
									"list"
								].map((value) => ({
									value,
									label: t(`work.view.${value}`),
									id: `dt-work-${value}`,
									panelId: "dt-work-view"
								}))
							})
						]
					}),
					waiting.map((item) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ApprovalCard, { approval: item }, item.id)),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dt-work-body",
						id: "dt-work-view",
						children: [view === "flow" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(FlowView, {
							team,
							selected,
							onSelect: setSelected
						}) : view === "board" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(BoardView, {
							team,
							onSelect: setSelected
						}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ListView, {
							team,
							onSelect: setSelected
						}), step && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(StepDetail, {
							team,
							step,
							onClose: () => setSelected(void 0)
						})]
					})
				]
			});
		}
		//#endregion
		//#region src/client/execution.tsx
		/** Execution status view (active Tickets and pause control) and Execution settings group (Executor capacity and workspace environment). */
		/** ★ 2026-11-09（用户要求）：流程图 / 看板 / 列表是「执行」页的一部分，不再是独立的 work 页面。
		*  `ticketId` 来自旧 `work?ticket=…` 深链（概况侧栏「查看流程」），用来预选团队。 */
		function ExecutionStatus({ filter: current, state, reload, ticketId }) {
			const { t, call, navigate } = usePanel();
			const [limit, setLimit] = (0, react.useState)(20);
			const { data, error, reload: reloadTickets } = usePoll(() => call("GET tickets", { query: {
				state: current,
				limit
			} }), [current, limit]);
			const { paused, load: { maxWorkers } } = state;
			const pause = async () => {
				await call("POST executor/pause", { body: { paused: !paused } });
				await reload();
			};
			const status = state.setup.problem ? {
				tone: "warning",
				label: t("executorWaitingSetup")
			} : paused ? {
				tone: "warning",
				label: t("processingPaused")
			} : {
				tone: "ongoing",
				label: t("executorRunning")
			};
			const action = paused ? "resumeProcessing" : "pauseProcessing";
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)(StatusHead, {
					hint: t("executionStatusIntro"),
					settings: "execution"
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)(GroupRuns, { compact: true }),
				/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "dt-row-meta dt-status-line",
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "dt-status-text",
							"data-state": status.tone,
							children: status.label
						}),
						!state.setup.problem && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(LabelValue, {
							label: t("executingLabel"),
							value: `${state.load.running} / ${maxWorkers}`
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(LabelValue, {
							label: t("queuedLabel"),
							value: state.load.queued
						})] }),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(ConfirmButton, {
							variant: "outline",
							icon: paused ? "play" : "pause",
							label: t(action),
							title: t(action),
							message: t(paused ? "resumeProcessingConfirm" : "pauseProcessingConfirm"),
							onConfirm: pause
						})
					]
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)(UsagePanel, {}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)(ApprovalRulesPanel, {}),
				state.health.p4?.code === "p4Unset" && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
					className: "dt-hint",
					children: [
						t("p4UnsetHint"),
						" ",
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: "dt-textlink",
							onClick: () => navigate(settingsRoute("execution")),
							children: t("sourceOpenSettings")
						})
					]
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					className: "dt-filters",
					children: TICKET_FILTERS.map((value) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Pill, {
						active: current === value,
						onClick: () => {
							setLimit(20);
							navigate({
								page: "execution",
								query: value === "open" ? {} : { filter: value }
							}, true);
						},
						children: t(`ticketFilter.${value}`)
					}, value))
				}),
				current === "idle" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Hint, { children: t("idleHint") }),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)(LoadState, {
					error,
					loading: !data
				}),
				data && (data.items.length ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("ul", {
					className: "dt-list",
					children: data.items.map((ticket) => ticket.stage === "person" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(TicketLine, {
						ticket,
						question: true,
						onChanged: reloadTickets
					}, ticket.id) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(TicketLine, { ticket }, ticket.id))
				}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Hint, { children: t("none") })),
				data?.next_offset != null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(LoadMore, { onMore: () => setLimit(limit + 20) }),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)(WorkPage, {
					ticketId,
					embedded: true
				}, ticketId)
			] });
		}
		const firstSentence = (text) => /^[^。；;.]*(?:[。；;]|\.(?=\s|$))?/.exec(text)?.[0] ?? text;
		function EnvironmentVariables({ groups, sources, onPick }) {
			const { t } = usePanel();
			const [open, setOpen] = (0, react.useState)(false);
			const owner = (id) => id === "executor" ? t("term.executor") : localized(t, sources.find((source) => source.id === id)?.title ?? id);
			const count = groups.reduce((sum, group) => sum + group.variables.length, 0);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(DisclosureRow, {
				icon: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Icon, { name: "hash" }),
				title: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
					t("environmentVariables"),
					" ",
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "dt-count",
						children: count
					})
				] }),
				open,
				onToggle: () => setOpen(!open),
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "dt-disclosure-body",
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Hint, { children: t("environmentPick") }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("table", {
						className: "dt-table",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("thead", { children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("tr", { children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", { children: t("environmentKey") }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", { children: t("environmentDescription") }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", { children: t("environmentOwner") })
						] }) }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("tbody", { children: groups.flatMap((group) => group.variables.map((variable) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("tr", { children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", { children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: "dt-textlink dt-mono",
								onClick: () => onPick(variable.key),
								children: variable.key
							}) }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
								title: localized(t, variable.description),
								children: firstSentence(localized(t, variable.description))
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("td", { children: [owner(group.owner), !group.enabled && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								className: "dt-hint",
								children: [" · ", t("sourceOff")]
							})] })
						] }, variable.key))) })]
					})]
				})
			});
		}
		function ExecutionSettings() {
			const { t } = usePanel();
			const { blocks, environment, sources } = useSettings().settings;
			const p4 = sources.find((source) => source.id === "p4");
			const executor = blocks.executor.value;
			const draft = useBlockDraft("executor", {
				...executor,
				maxWorkers: String(executor.maxWorkers),
				blockedCommands: executor.blockedCommands.join(" ")
			}, blocks.executor.revision, (value) => ({
				...value,
				maxWorkers: numberOf(value.maxWorkers),
				blockedCommands: value.blockedCommands.split(/[\s,]+/).filter(Boolean)
			}));
			const value = draft.value;
			const edit = (next) => draft.edit({
				...value,
				...next
			});
			const prepare = (0, react.useRef)(null);
			const insert = (key) => {
				const field = prepare.current;
				const at = field?.selectionStart ?? value.prepare.length, to = field?.selectionEnd ?? at;
				edit({ prepare: `${value.prepare.slice(0, at)}"$${key}"${value.prepare.slice(to)}` });
				requestAnimationFrame(() => {
					field?.focus();
					const caret = at + key.length + 3;
					field?.setSelectionRange(caret, caret);
				});
			};
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "dt-form",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("form", {
						className: "dt-form",
						onSubmit: (event) => {
							draft.submit(event);
						},
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)(Fields, {
							disabled: draft.busy,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "dt-form dt-block",
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("h2", {
										className: "dt-block-title",
										children: [t("term.executor"), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(InfoTip, { text: t("executorIntro") })]
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Section, {
										title: t("executorModel"),
										hint: t("executorModelHint"),
										children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ModelField, {
											id: "dt-worker-model",
											value: value.model,
											onChange: (model) => edit({ model })
										})
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Field, {
										label: t("maxWorkers"),
										hint: t("maxWorkersHint"),
										children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Input, {
											type: "number",
											min: LIMITS.maxWorkers.min,
											max: LIMITS.maxWorkers.max,
											required: true,
											value: value.maxWorkers,
											onChange: (event) => edit({ maxWorkers: event.target.value })
										})
									})
								]
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "dt-form dt-block",
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("h2", {
										className: "dt-block-title",
										children: [t("term.environment"), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(InfoTip, { text: t("environmentIntro") })]
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Field, {
										label: t("executionDirectory"),
										hint: t("executionDirectoryHint"),
										note: value.directory ? void 0 : t("executionDirectoryDefault", { root: environment.root }),
										children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Input, {
											className: "dt-mono",
											value: value.directory,
											placeholder: t("executionDirectoryEmpty"),
											spellCheck: false,
											pattern: "/.*",
											onChange: (event) => edit({ directory: event.target.value })
										})
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Field, {
										label: t("prepareCommand"),
										hint: t("prepareCommandHint"),
										children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("textarea", {
											ref: prepare,
											className: "dt-textarea dt-mono",
											rows: 3,
											maxLength: LIMITS.prepareCommand,
											spellCheck: false,
											placeholder: t("prepareCommandEmpty"),
											value: value.prepare,
											onChange: (event) => edit({ prepare: event.target.value })
										})
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)(EnvironmentVariables, {
										groups: environment.variables,
										sources,
										onPick: insert
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Field, {
										label: t("blockedCommands"),
										hint: t("blockedCommandsHint"),
										children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Input, {
											className: "dt-mono",
											value: value.blockedCommands,
											placeholder: t("blockedCommandsNone"),
											spellCheck: false,
											onChange: (event) => edit({ blockedCommands: event.target.value })
										})
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)(SwitchRow, {
										label: t("sideCalls"),
										hint: t("sideCallsHint"),
										checked: value.sideCalls,
										onChange: (sideCalls) => edit({ sideCalls })
									})
								]
							})]
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(SaveBar, {
							...draft,
							onDiscard: draft.discard
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(ConfigHistory, { blocks: ["executor", "pause"] }),
					p4 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(SourceCard, {
						source: p4,
						title: t("p4Block")
					}),
					p4 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ConfigHistory, { blocks: ["source:p4"] })
				]
			});
		}
		new Intl.Segmenter("zh", { granularity: "word" });
		//#endregion
		//#region src/setup.ts
		const SETUP_PROBLEMS = {
			foreignFile: ["deployment", "{file} was not written by dsh-superagent; move it, or choose another state directory."],
			gitTooOld: ["deployment", "git does not read the github.com credential configuration dsh-superagent writes; dsh-superagent needs git 2.32 or later."],
			environmentFailed: ["deployment", "Preparing the agent environment failed."],
			repositoryUnset: ["github", "The GitHub Source names no repository."],
			agentCliUnset: ["github", "The agent GitHub CLI is not set."],
			agentCliMissing: ["github", "The agent GitHub CLI was not found."],
			agentCliSignedOut: ["github", "The agent GitHub CLI cannot read its account."],
			agentCliNoAccount: ["github", "The agent GitHub CLI did not report a GitHub account."],
			repositoryUnreadable: ["github", "@{account} cannot read {repository}."],
			repositoryUnreported: ["github", "The agent GitHub CLI did not return {repository}."],
			repositoryReadOnly: ["github", "@{account} cannot push to {repository}."],
			feishuCliFailed: ["feishu", "The bot lark-cli does not work."],
			feishuNoApp: ["feishu", "auth status of the bot lark-cli did not report the app."],
			feishuBotNotReady: ["feishu", "The bot identity of app {app} is {status}; configure the app secret with lark-cli."],
			feishuUserIdentity: ["feishu", "The bot lark-cli allows user identities (strict mode {mode}); give the bot its own lark-cli configuration in strict mode bot, as docs/006-deployment.md describes."],
			feishuNoBot: ["feishu", "The Feishu bot API did not return the bot's open_id."],
			feishuAppMissing: ["feishu", "lark-cli has no profile for Feishu app {app}, and the VsSaros Bots do not keep its secret; add the app in the Bots channel settings, or run lark-cli profile add --name {app} --app-id {app} --app-secret-stdin."],
			feishuProfileFailed: ["feishu", "lark-cli could not add a bot-only profile for Feishu app {app}: {output}"],
			feishuAppMismatch: ["feishu", "lark-cli profile {profile} belongs to app {actual}, not {app}."]
		};
		//#endregion
		//#region src/sources/host.ts
		/** Fixed English health templates (`{name}` placeholders); the panel localizes each `code` in the interface language. */
		const HEALTH_TEXT = {
			setupPending: "Waiting for the deployment check",
			sourceOff: "Off",
			feishuCliUnset: "The Source is on, and its bot lark-cli is not set",
			feishuAppShared: "Feishu app {app} already receives events in the Bots inbound of {holder}; Feishu delivers each event to one connection only, so give this Source its own Feishu app",
			feishuBusBusy: "Another event consumer already holds Feishu app {app}; Feishu delivers each event to one connection only, so stop it or give this Source its own Feishu app",
			feishuShared: "Receiving events of Feishu app {app} through the VsSaros Bots connection in this Host",
			githubUnset: "The Source is on, and its repository and account CLI are not set",
			p4Unset: "P4 is on, and its server, execution account and allowed paths are not all set",
			tapdUnset: "The Source is on, and no watch is set",
			tapdWebhookUnset: "The TAPD Webhook is on, and its shared secret is not set",
			feishuBotMissing: "Waiting for the Feishu bot",
			pollFailures: "{count} consecutive failed polls; last: {error}"
		};
		//#endregion
		//#region src/client/locales.ts
		/**
		* Bilingual UI dictionaries (`[zh, en]`) and glossary groupings, following the domain terms in `docs/001-domain.md`.
		*/
		const TEXT = {
			title: ["Superagent", "Superagent"],
			close: ["关闭", "Close"],
			cancel: ["取消", "Cancel"],
			confirm: ["确定", "Confirm"],
			loading: ["正在读取…", "Loading…"],
			loadMore: ["加载更多", "Load more"],
			offline: ["无法连接到 dsh-superagent 服务。请确认它正在运行（dsh-superagent status），然后重试。", "Cannot reach the dsh-superagent service. Check that it is running (dsh-superagent status), then retry."],
			serverError: ["dsh-superagent 服务内部错误（{status}），请查看运行日志后重试。", "dsh-superagent service error ({status}). Check the log, then retry."],
			requestFailed: ["请求失败（{status}）。", "Request failed ({status})."],
			empty: ["—", "—"],
			yes: ["是", "Yes"],
			no: ["否", "No"],
			"decision.accept": ["接单", "Accept"],
			"decision.reopen": ["续做", "Reopen"],
			"decision.stop": ["停止", "Stop"],
			"decision.ignore": ["忽略", "Ignore"],
			"decision.unavailable": ["未完成", "Unavailable"],
			"strength.explicit": ["明确", "Explicit"],
			"strength.inferred": ["推断", "Inferred"],
			"mode.off": ["关闭", "Off"],
			"mode.observe": ["仅观察", "Observe"],
			"mode.auto": ["自动接单", "Auto"],
			"source.feishu": ["飞书", "Feishu"],
			"source.github": ["GitHub", "GitHub"],
			"source.github-issue": ["GitHub Issue", "GitHub Issue"],
			"source.superagent": ["主管对话", "Supervisor desk"],
			"health.github": ["GitHub 来源", "GitHub Source"],
			"health.feishu": ["飞书来源", "Feishu Source"],
			"health.history": ["飞书补收", "Feishu recovery"],
			"health.runtime": ["dsh-superagent", "dsh-superagent"],
			"health.models": ["模型服务", "Model service"],
			"health.assessment": ["发给主 Session 的评估", "Evals sent to the main Session"],
			"health.launch": ["派工启动", "Assignment launches"],
			"health.delivery": ["输入送达", "Input delivery to Assignments"],
			"health.relay": ["转达给主 Session 的消息", "Relays to the main Session"],
			"health.notice": ["给主 Session 的通知", "Notices to the main Session"],
			"health.reply": ["发往渠道的消息", "Messages to Channels"],
			"health.worker": ["执行器事件处理", "Executor event handling"],
			"health.evals": ["未完成的评估", "Unavailable Evals"],
			none: ["暂无。", "None."],
			openSession: ["打开 Session", "Open Session"],
			stop: ["停止", "Stop"],
			policyVersion: ["策略版本", "Policy version"],
			mediaMarker: ["[媒体]", "[Media]"],
			forwardMarker: ["[合并转发]", "[Merged forward]"],
			ticketId: ["工单 id", "Ticket id"],
			wouldAccept: ["忽略（可接单，仅观察）", "Ignore (would accept; observe only)"],
			timeline: ["触发时间线", "Trigger timeline"],
			groupMember: ["飞书用户", "Feishu user"],
			feishuBot: ["飞书机器人", "Feishu bot"],
			unknownMention: ["@某人", "@someone"],
			automatedNotice: ["自动通知", "Automated notice"],
			requeue: ["重新评估", "Evaluate again"],
			imageMarker: ["[图片]", "[image]"],
			rules: ["接单规则", "Accept rules"],
			remove: ["删除", "Delete"],
			"historySource.panel": ["管理页", "Management page"],
			"historySource.defaults": ["插件默认值", "Plugin defaults"],
			"historySource.tool": ["主 Session 工具", "Main Session tool"],
			"historySource.sync": ["从群同步", "Sync"],
			"historySource.web": ["管理页", "Management page"],
			"historySource.member-sync": ["成员同步", "Member sync"],
			"historySource.orchestrator-tool": ["主 Session 工具", "Main Session tool"],
			"historySource.internal": ["内部", "Internal"],
			"historySource.policy-sync": ["从群同步", "Sync"],
			"historySource.sections-migration": ["升级迁移", "Upgrade migration"],
			"historySource.vocabulary-migration": ["升级迁移", "Upgrade migration"],
			"historySource.settings-migration": ["升级迁移", "Upgrade migration"],
			listSeparator: ["、", ", "],
			labelSeparator: ["：", ": "],
			lang: ["zh", "en"],
			automatedEarlier: ["同一发送者之前还有 {count} 条自动消息", "{count} earlier automated messages from the same sender"],
			collapse: ["收起", "Collapse"],
			expand: ["展开全文", "Show all"],
			cardMarker: ["[卡片消息]", "[card message]"],
			setupProblem: ["部署检查未通过：{detail}", "Deployment check failed: {detail}"],
			hostNotRunning: ["dsh-superagent 没有响应：它可能正在重启；持续如此时，DSH 的日志写明原因，常见的是配置有误。", "dsh-superagent is not answering: it may be restarting; if this persists, the DSH log names the cause, often a configuration error."],
			savedRestarting: ["已保存，dsh-superagent 正在重启", "Saved; dsh-superagent is restarting"],
			problems: ["系统问题", "System problems"],
			dismiss: ["不再提示", "Dismiss"],
			saved: ["已保存", "Saved"],
			"tab.settings": ["设置", "Settings"],
			statusTitle: ["状态", "Status"],
			executingLabel: ["执行中", "Executing"],
			queuedLabel: ["排队", "Queued"],
			resumeProcessing: ["恢复处理", "Resume processing"],
			resumeProcessingConfirm: ["恢复后继续评估、派工和发送回复。", "Resuming starts Evals, Assignments and replies again."],
			restartInterrupts: ["保存会重启 dsh-superagent：{count} 个进行中的派工会中断，并带恢复说明重新开始。", "Saving restarts dsh-superagent: {count} running Assignments stop and start again with a recovery note."],
			sourceOff: ["已关闭", "Off"],
			executorWaitingSetup: ["执行器等待部署检查", "Executor waiting for the deployment check"],
			panel: ["Superagent", "Superagent"],
			openMaster: ["打开主 Session", "Open main Session"],
			pagesLabel: ["dsh-superagent 页面", "dsh-superagent pages"],
			searchPlaceholder: ["搜索工单、线程、触发或链接", "Search Tickets, Threads, Triggers or links"],
			searchLabel: ["搜索", "Search"],
			searchFound: ["找到 {tickets} 个工单、{threads} 个线程、{items} 条触发", "Found {tickets} Tickets, {threads} Threads and {items} Triggers"],
			searchNone: ["没有找到。可以输入触发文字、GitHub PR 或 Issue 链接、#编号、飞书消息链接或 om_ 开头的消息 id。", "Nothing found. Try Trigger text, a GitHub PR or Issue link, #number, a Feishu message link, or an om_ message id."],
			searchNoneGithub: ["没有找到。可以输入触发文字、GitHub PR 或 Issue 链接或 #编号。", "Nothing found. Try Trigger text, a GitHub PR or Issue link, or #number."],
			"ticket.ended": ["已结束", "ended"],
			sessionListNotReady: ["Session 列表尚未加载，请稍后重试。", "The Session list has not loaded yet; try again shortly."],
			sessionNotListed: ["这个 Session 不在当前会话列表里，可能已被归档或删除。", "This Session is not in the current list; it may have been archived or deleted."],
			searchFiltered: ["被来源过滤：{reason}", "Filtered by its Source: {reason}"],
			searchFoundCapped: ["找到 {tickets} 个工单、{threads} 个线程、前 {items} 条触发（请缩小搜索范围）", "Found {tickets} Tickets, {threads} Threads and the first {items} Triggers (narrow the search)"],
			inThread: ["在 {thread}", "in {thread}"],
			"tab.overview": ["概况", "Overview"],
			"tab.chat": ["对话", "Chat"],
			openOverview: ["打开概况面板", "Open the overview panel"],
			"side.open": ["打开侧边栏", "Open the side panel"],
			"side.close": ["收起侧边栏", "Close the side panel"],
			"side.resize": ["拖动调整侧边栏宽度", "Drag to resize the side panel"],
			"side.autoOpened": ["主管开始了新的工作，已打开概况面板。", "The supervisor started new work; the overview panel opened."],
			"side.autoOpenedApproval": ["有步骤在等你批准，已打开概况面板。", "A step waits for your approval; the overview panel opened."],
			"chat.nativeOpening": ["正在打开主管对话…", "Opening the supervisor desk…"],
			"chat.dock": ["等你处理", "Waiting for you"],
			"chat.nativeFailed": ["主管对话没能在这里打开（{error}），先用面板里的对话。", "The supervisor desk could not open here ({error}); the panel's chat is shown instead."],
			"tab.work": ["工作台", "Workbench"],
			"work.needsYou": ["需要你处理", "Needs you"],
			"work.approvalTitle": ["{bot} 想越出工作目录（{step}）", "{bot} wants to go beyond its directory ({step})"],
			"work.approvalFeishu": ["也发到了工单的飞书话题，回复「同意 #{code}」也行。", "Also sent to the ticket's Feishu thread; replying \"同意 #{code}\" there works too."],
			"work.allow": ["允许一次", "Allow once"],
			"work.remember": ["允许并记住", "Allow and remember"],
			"work.reject": ["拒绝", "Refuse"],
			"work.waitsForYou": ["等你批准", "Waits for you"],
			"work.writes": ["写", "Writes"],
			"work.reads": ["只读", "Read-only"],
			"work.approvalExpires": ["{time} 前没人批就按拒绝处理", "Refused at {time} if no one answers"],
			"work.approvalRestored": ["SuperAgent 重启前就在等：批准后会告诉它重新运行这条命令", "It waited through a SuperAgent restart: if allowed, its Bot is told to run it again"],
			"work.unsandboxed": ["无沙箱", "No sandbox"],
			"work.needsSandbox": ["这台机器不能给工作目录加沙箱，等你决定", "This machine cannot sandbox the directory; waits for you"],
			"work.needsPermission": ["权限设置失败，等你决定", "Its permission could not be set; waits for you"],
			"work.allowUnsandboxed": ["允许无沙箱运行", "Run without a sandbox"],
			"work.unsandboxedHint": ["这台机器不能给工作目录加沙箱：命令不受限制，只有文件工具被限制在目录内。", "This machine cannot sandbox the directory: commands are not limited; only file tools are kept inside it."],
			"work.stop": ["停止", "Stop"],
			"work.stopStep": ["停止步骤 {step}", "Stop step {step}"],
			"work.turns": ["{turns} 回合", "{turns} turns"],
			"work.now": ["正在", "Now"],
			"work.attempts": ["尝试记录", "Attempts"],
			"work.attempt": ["第 {n} 次", "Attempt {n}"],
			"work.openSession": ["打开这个 bot 的会话", "Open this Bot's Session"],
			"work.openFlow": ["在执行页查看「{title}」的流程", "Open the flow of \"{title}\" on the Execution page"],
			"work.detail": ["步骤 {step}", "Step {step}"],
			"work.empty": ["现在没有团队在干活。主管组好的团队开工后，流程、看板和列表会显示在这里。", "No team is at work. Once a team the supervisor staffed starts, its flow, board and list show here."],
			"work.teams": ["团队", "Teams"],
			"work.views": ["视图", "Views"],
			"work.view.flow": ["流程图", "Flow"],
			"work.view.board": ["看板", "Board"],
			"work.view.list": ["列表", "List"],
			"groupRuns.title": ["群聊执行", "Group chats"],
			"groupRuns.status.running": ["已发到群", "Sent to group"],
			"groupRuns.status.replying": ["正在回答", "Replying"],
			"groupRuns.status.done": ["已完成", "Done"],
			"groupRuns.status.error": ["执行失败", "Failed"],
			"groupRuns.status.cut": ["已中断", "Interrupted"],
			"groupRuns.note": ["群成员在各自会话里执行，不占上方「执行中」的执行器槽位。", "Group members run in their own sessions and do not take the executor slots counted above."],
			"groupRuns.open": ["打开群聊", "Open group chat"],
			"groupRuns.source.post": ["来自对话里的 @群", "From an @group in a conversation"],
			"groupRuns.source.created": ["来自建群请求", "From a group request"],
			"groupRuns.source.trigger": ["触发 {id}", "Trigger {id}"],
			"groupRuns.replies": ["{n} 条回复", "{n} replies"],
			"groupRuns.elapsed": ["用时 {n}s", "{n}s elapsed"],
			"groupRuns.failed": ["{n} 位成员失败", "{n} failed"],
			"groupRuns.member.speaking": ["正在输入", "Typing"],
			"groupRuns.member.replied": ["已回复", "Replied"],
			"groupRuns.member.passed": ["无补充", "Passed"],
			"groupRuns.member.failed": ["未回答", "Failed"],
			"groupRuns.member.waiting": ["等待中", "Waiting"],
			"work.zoomIn": ["放大", "Zoom in"],
			"work.zoomOut": ["缩小", "Zoom out"],
			"work.fit": ["复位", "Reset"],
			"work.col.pending": ["等待", "Waiting"],
			"work.col.running": ["进行中", "Running"],
			"work.col.blocked": ["待人处理", "Needs a person"],
			"work.col.ready": ["完成", "Done"],
			"work.col.ended": ["未完成结束", "Ended unfinished"],
			"work.col.step": ["步骤", "Step"],
			"work.col.bot": ["负责 bot", "Bot"],
			"work.col.after": ["依赖", "After"],
			"work.col.access": ["权限", "Access"],
			"work.col.state": ["状态", "State"],
			"work.col.turns": ["回合", "Turns"],
			"work.doing.think": ["想一想", "Thinking"],
			"work.doing.look": ["查找文件", "Looking through files"],
			"work.doing.write": ["写入修改", "Writing changes"],
			"work.doing.shell": ["运行命令", "Running a command"],
			"work.doing.web": ["查网页", "Reading the web"],
			"work.doing.subagent": ["派子任务", "Running a subagent"],
			"work.doing.plan": ["更新待办", "Updating its plan"],
			"work.doing.report": ["汇报结果", "Reporting"],
			"work.doing.tool": ["使用 {tool}", "Using {tool}"],
			"flow.handing": ["正在交给 SuperAgent 主管…", "Handing it to the SuperAgent supervisor…"],
			"flow.handed": ["已交给 SuperAgent 主管", "Handed to the SuperAgent supervisor"],
			"flow.evaluating": ["主管正在评估这条消息…", "The supervisor is evaluating this message…"],
			"flow.evalRetry": ["评估暂时不可用，主管稍后再试…", "Eval is unavailable for now; the supervisor tries again…"],
			"flow.filtered": ["没有交给主管：主管对话没有打开", "Not handed over: the supervisor desk is switched off"],
			"flow.declined": ["主管没有接手这条消息", "The supervisor did not take this message"],
			"flow.groupCreated": ["已建群「{name}」", "Made the group \"{name}\""],
			"flow.groupRouted": ["已交给群「{name}」", "Handed to the group \"{name}\""],
			"flow.groupUpdated": ["已有同名群「{name}」，已在群里更新成员", "A group named \"{name}\" existed; its members were updated"],
			"flow.groupNote": ["由群成员接手，主管不再另行处理；群里开始后这里会显示进度。", "The group's members take it; the supervisor does not handle it again. Progress shows here once the group starts."],
			"flow.alsoGroup": ["这条消息也交给了群「{name}」。", "This message also went to the group \"{name}\"."],
			"flow.followup": ["已转给工单「{title}」", "Passed to the ticket \"{title}\""],
			"flow.taken": ["主管已接手，建了工单", "The supervisor took it as a ticket"],
			"flow.proposing": ["主管正在组队…", "The supervisor is staffing a team…"],
			"flow.proposal": ["组队方案 v{version}", "Team proposal v{version}"],
			"flow.risk": ["新建 {bots} 个 bot · {writes} 个写步骤", "{bots} new Bots · {writes} writing steps"],
			"flow.team": ["团队执行 · {done}/{total} 完成", "Team at work · {done}/{total} done"],
			"flow.teamStarting": ["团队准备开工…", "The team is getting ready…"],
			"flow.report": ["等你看结果", "Waits for you to read the result"],
			"flow.ended": ["结束：{outcome}", "Ended: {outcome}"],
			"flow.receipt": ["工单已结束：{title}", "Ticket ended: {title}"],
			"flow.receiptLoading": ["工单已结束", "A ticket ended"],
			"chat.empty": ["还没有对话。在下面对主管说一个需求：它先评估，要接手就发组队方案给你确认。", "No conversation yet. Tell the supervisor what you need below: it evaluates it, and sends you a team proposal to agree to before any work starts."],
			"chat.placeholder": ["给 SuperAgent 发消息", "Message SuperAgent"],
			"chat.label": ["给主管的消息", "Message to the supervisor"],
			"chat.send": ["发送", "Send"],
			"chat.pending": ["发送中", "Sending"],
			"chat.queued": ["随后送达 · 自动并入主管当前回合", "On its way · joins the supervisor's current turn"],
			"chat.sendFailed": ["发送失败，草稿已保留", "Failed to send; draft kept"],
			"chat.activity": ["主管正在处理…", "Supervisor is working…"],
			"chat.queuedCount": ["{n} 条正在送达", "{n} on the way"],
			"composer.queued": ["{n} 条正在送达；主管处理中收到的消息会自动并入当前回合", "{n} on the way; messages that arrive while the supervisor works join its current turn"],
			"composer.add": ["添加", "Add"],
			"composer.addFiles": ["添加文件", "Add files"],
			"composer.reference": ["引用对话", "Reference a chat"],
			"composer.schedule": ["定时任务", "Scheduled task"],
			"composer.referenceTitle": ["引用哪个对话", "Which chat to reference"],
			"composer.referenceEmpty": ["还没有可以引用的对话。", "No chat to reference yet."],
			"composer.referenceText": ["引用对话「{title}」（线程 {key}）", "Referencing the chat \"{title}\" (Thread {key})"],
			"composer.removeFile": ["移除 {name}", "Remove {name}"],
			"composer.tooManyFiles": ["一条消息最多附 {count} 个文件。", "A message takes at most {count} files."],
			"composer.fileTooBig": ["「{name}」超过 10 MB，没有加上。", "\"{name}\" is over 10 MB and was not added."],
			"composer.uploading": ["正在上传附件…", "Uploading the attachments…"],
			"composer.attachmentsHeader": ["附件：", "Attachments:"],
			"composer.dictate": ["听写", "Dictate"],
			"composer.stopDictation": ["停止听写", "Stop dictation"],
			"composer.dictationUnavailable": ["这个环境不支持听写", "Dictation is not available here"],
			"composer.dictationOffline": ["连不上语音识别服务", "The speech recognition service cannot be reached"],
			"composer.micBlocked": ["麦克风权限被阻止了", "Microphone access is blocked"],
			"composer.notHeard": ["没听清", "Couldn't hear that"],
			"composer.voiceStart": ["开始语音对话", "Start voice chat"],
			"composer.voiceTitle": ["语音对话", "Voice chat"],
			"voice.listening": ["在听", "Listening"],
			"voice.thinking": ["想一想…", "Thinking…"],
			"voice.speaking": ["在说", "Speaking"],
			"voice.paused": ["已暂停", "Paused"],
			"voice.unsupported": ["这个环境不支持语音对话", "Voice chat is not available here"],
			"voice.pause": ["暂停", "Pause"],
			"voice.resume": ["继续听", "Resume listening"],
			"voice.end": ["结束语音对话", "End voice chat"],
			"voice.slow": ["主管还在处理，回复会显示在对话里。", "The supervisor is still working; the answer will show in the chat."],
			"schedule.title": ["定时任务", "Scheduled task"],
			"schedule.description": ["到时间后，这条消息以你的名义发给主管，和你在这里发的一样走准入、评估和组队。", "At its time, this message goes to the supervisor as yours, through the same gate, Eval and staffing as one sent here."],
			"schedule.text": ["内容", "Message"],
			"schedule.at": ["时间", "Time"],
			"schedule.repeat": ["重复", "Repeat"],
			"schedule.none": ["不重复", "Once"],
			"schedule.daily": ["每天", "Every day"],
			"schedule.weekdays": ["工作日", "Weekdays"],
			"schedule.save": ["添加定时任务", "Add the scheduled task"],
			"schedule.saved": ["已添加定时任务，{when} 发送。", "Scheduled for {when}."],
			"schedule.list": ["已有的定时任务", "Scheduled tasks"],
			"schedule.empty": ["还没有定时任务。", "No scheduled tasks yet."],
			"schedule.delete": ["删除", "Delete"],
			"schedule.close": ["关闭", "Close"],
			"chat.supervisor": ["SuperAgent", "SuperAgent"],
			"chat.waiting": ["待你确认", "Awaiting you"],
			"chat.agree": ["回复同意", "Reply agree"],
			"chat.refuse": ["回复取消", "Reply cancel"],
			"chat.agreeText": ["同意", "Agree"],
			"chat.refuseText": ["取消", "Cancel"],
			"chat.viewOverview": ["在概况面板查看", "View in the overview panel"],
			"chat.notHanded": ["没有交给主管：{reason}", "Not handed to the supervisor: {reason}"],
			"chat.filtered": ["这条消息没有交给主管：「superagent」来源关掉了主管对话。", "This message was not handed to the supervisor: the superagent Source does not receive the desk."],
			"tab.source": ["来源", "Source"],
			"tab.trigger": ["触发", "Trigger"],
			"tab.eval": ["评估", "Eval"],
			"tab.execution": ["执行", "Execution"],
			sourceError: ["{source} 来源异常", "{source} Source failing"],
			needsYouNone: ["没有待处理的工单。", "No pending Tickets."],
			pendingTickets: ["待处理工单", "Pending Tickets"],
			problemEvalOverdue: ["评估超时未决定：{thread}", "Eval overdue: {thread}"],
			problemSetup: ["部署检查未通过，dsh-superagent 暂不接单", "Deployment check failed; dsh-superagent takes no work"],
			problemNoSource: ["没有运行中的来源，不会收到任何触发", "No Source is running; no Triggers arrive"],
			actionOpenSources: ["去打开来源", "Turn on a Source"],
			problemPaused: ["处理已暂停：不开始新的评估，不派工，不发送回复", "Processing paused: no new Evals, Assignments or replies"],
			problemReply: ["{source} 回复发送失败（已重试 {attempts} 次）", "{source} reply failing (retried {attempts} times)"],
			problemRuntime: ["运行异常：{name}", "{name} failing"],
			problemEvalUnavailable: ["评估未完成：{thread}", "Eval unavailable: {thread}"],
			sourceErrorHint: ["来源会在每次轮询时自动重试。持续出现时检查网络和该来源的登录状态。", "The Source retries on every poll. If this persists, check the network and the Source's sign-in."],
			details: ["详情 ›", "Details ›"],
			lastDay: ["过去 24 小时", "Last 24 hours"],
			flowReceivedLabel: ["到达", "Arrived"],
			flowFilteredLabel: ["被过滤", "Filtered"],
			flowDroppedLabel: ["放弃发送", "Not sent"],
			flowJudgedLabel: ["已评估", "Evaluated"],
			flowAcceptedLabel: ["接单或续做", "Accepted or continued"],
			idleLabel: ["等待新触发", "Waiting for a Trigger"],
			problemNoAllowed: ["没有人能发起工作：各来源上的名单都为空，任何请求都不会成为工单", "No one may originate work: the lists on every Source are empty, so no request can become a Ticket"],
			actionAddAllowed: ["去添加", "Add senders"],
			"problemSetupFix.github": ["在设置 › 来源的 GitHub 卡片修正后保存，会重新检查；在 dsh-superagent 之外修复的（例如登录 CLI），点“重新检查”。", "Fix it on the GitHub card of the Source settings and save to check again; after a fix outside dsh-superagent, such as signing a CLI in, choose Check again."],
			"problemSetupFix.feishu": ["在设置 › 来源的飞书卡片修正后保存，会重新检查；在 dsh-superagent 之外修复的（例如配置机器人），点“重新检查”。", "Fix it on the Feishu card of the Source settings and save to check again; after a fix outside dsh-superagent, such as configuring the bot, choose Check again."],
			"problemSetupFix.deployment": ["在部署设置里修正后保存，会重新检查；在 dsh-superagent 之外修复的（例如升级 git），点“重新检查”。", "Fix it in the Deployment settings and save to check again; after a fix outside dsh-superagent, such as upgrading git, choose Check again."],
			problemSetupFeishu: ["飞书机器人检查未通过，飞书来源暂停", "Feishu bot check failed; the Feishu Source is paused"],
			labelsAdded: ["列表已更新，新增：{names}", "List updated, added: {names}"],
			labelsCurrent: ["列表已是最新", "List is up to date"],
			labelsFailed: ["读取失败，列表保持不变：{error}", "Could not read the list; it stays as it was: {error}"],
			sourceNotInstalled: ["插件未安装", "Plugin not installed"],
			sourceNotInstalledHint: ["提供这个来源的插件没有加载，配置按保存时的样子保留。", "The plugin that provides this Source is not loaded; its configuration is kept as saved."],
			sourceEnable: ["运行来源：{name}", "Run Source: {name}"],
			addRow: ["添加", "Add"],
			removeRow: ["移除：{name}", "Remove: {name}"],
			sourceFilteredTitle: ["24 小时内最近被过滤的触发", "Latest Triggers filtered in the last 24 hours"],
			sourceDroppedTitle: ["24 小时内放弃发送的消息", "Not sent in the last 24 hours"],
			sourceDroppedHint: ["这些消息要发往的对话已无法接收，或来源已不再监听该对话，因此放弃发送。", "Their conversation can no longer receive them, or the Source no longer listens to it, so they are not sent."],
			sourceStatusIntro: ["每个来源是否在运行、过去 24 小时到达和被过滤的触发，以及被过滤的原因。", "Whether each Source runs, the Triggers that arrived and were filtered in the last 24 hours, and why they were filtered."],
			sourceReceivedLabel: ["24 小时到达", "Arrived in 24 h"],
			sourceFilteredLabel: ["被过滤", "Filtered"],
			sourceLatestLabel: ["最近", "Latest"],
			advanced: ["高级", "Advanced"],
			"sourceState.done": ["运行中", "Running"],
			"sourceState.ongoing": ["启动中", "Starting"],
			"sourceState.warning": ["待处理", "Pending"],
			"sourceState.error": ["出错", "Failing"],
			sourceOpenSettings: ["去设置", "Open settings"],
			"sourceState.setup": ["等待部署检查", "Waiting for the deployment check"],
			setupFixLink: ["去修正", "Fix it"],
			"openSettingsOf.deployment": ["去部署页修改", "Change it on Deployment"],
			loadEarlier: ["加载更早的触发", "Load earlier Triggers"],
			subscribedTickets: ["订阅此线程的工单", "Tickets subscribed to this Thread"],
			threadNotFound: ["找不到这个线程。", "Thread not found."],
			threadsNone: ["没有符合条件的线程。", "No matching Threads."],
			threadLatest: ["最近 {time}", "Latest {time}"],
			threadCreated: ["创建 {time}", "Created {time}"],
			threadEvaluating: ["评估进行中", "Eval running"],
			pollFailed: ["轮询失败：{error}", "Polling failed: {error}"],
			unsubscribe: ["取消订阅", "Unsubscribe"],
			unsubscribeTitle: ["取消订阅", "Unsubscribe"],
			unsubscribeConfirm: ["取消后，“{title}”的新触发不再扇出给工单，直到下一次接单或关联。", "New Triggers in \"{title}\" will stop fanning out to Tickets until the next accept or attach."],
			unsubscribePending: ["已取消订阅，结果等待注入主 Session。", "Unsubscribed; the receipt is waiting to reach the main Session."],
			openOriginal: ["打开原文", "Open original"],
			evaluatingBanner: ["评估进行中：{count} 条触发，{strength}，{deadline} 到期。", "Eval running: {count} Triggers, {strength}, due {deadline}."],
			noTriggers: ["没有保留的触发。", "No retained Triggers."],
			dispositionQueued: ["已排队，等待评估", "Queued for Eval"],
			dispositionEvaluating: ["评估进行中", "Eval running"],
			dispositionFanout: ["扇出到 {count} 个工单", "Fanned out to {count} Tickets"],
			dispositionDelivered: ["已送达工单", "Delivered to Ticket"],
			dispositionDeliveredHint: ["有人在已有工单的线程上跟进时，消息直接送达工单的执行器，不经评估，也不产生决定。", "A person's follow-up on a Thread with a Ticket goes straight to the Ticket's Executor, with no Eval and no Decision."],
			handedBack: ["“{ticket}”的执行器把这条触发交回评估：{reason}", "The Executor of “{ticket}” handed it back for an Eval: {reason}"],
			inputHandedBack: ["已交回评估：{reason}", "Handed back for an Eval: {reason}"],
			contextOnly: ["仅作上下文", "Context only"],
			contextOnlyHint: ["执行器关注这个线程只为了解情况：这里的消息会送达工单，但不带授权，也不会恢复已结束的工单。", "The Executor follows this Thread only to stay informed: its messages reach the Ticket but grant nothing and resume no ended Ticket."],
			requeueAlready: ["这条触发已经在评估中。", "This Trigger is already in an Eval."],
			andMore: ["等 {count} 个", " and {count} more"],
			newestFirst: ["最新在前", "newest first"],
			openTicket: ["查看工单", "Open Ticket"],
			tagFiltered: ["已过滤：{reason}", "Filtered: {reason}"],
			threadDormantShort: ["工单已结束", "Tickets ended"],
			threadPollFailed: ["轮询失败", "Polling failed"],
			threadQueued: ["排队 {count}", "{count} queued"],
			threadSubscribed: ["已订阅", "Subscribed"],
			threadUnsubscribed: ["未订阅", "Not subscribed"],
			fanoutTo: ["扇出给", "Fans out to"],
			unsubscribeHint: ["取消订阅后，这个线程的新触发不再扇出给工单，直到下一次接单或关联。", "After unsubscribing, new Triggers here stop fanning out to Tickets until the next accept or attach."],
			"threadFilter.subscribed": ["已被订阅", "Subscribed"],
			"threadFilter.evaluating": ["评估中", "Evaluating"],
			"threadFilter.recent": ["24 小时内有新触发", "New Triggers in 24 h"],
			"threadFilter.all": ["全部线程", "All Threads"],
			triggerIntro: ["触发按线程归组；线程决定它们扇出给哪些工单、由哪次评估处理。", "Triggers grouped by Thread; the Thread decides which Tickets they fan out to and which Eval handles them."],
			threadDecisions: ["这个线程的决定 · {count}", "Decisions in this Thread · {count}"],
			policyVersionHint: ["策略版本由接单规则、各来源上的策略和评估的接单模式决定；修改任何一项都会生成新版本，并通知进行中的工单。每个工单记下接单时的版本。", "The rules, the Policy on each Source and the accept mode of Eval make up the Policy version; any change makes a new version and notifies open Tickets. Each Ticket records the version it was accepted under."],
			syncNeedsSave: ["请先保存或放弃修改，再同步。", "Save or discard your changes before syncing."],
			acceptMode: ["接单模式", "Accept mode"],
			"modeOption.off": ["只处理明确的请求，不评估其他触发", "Only explicit requests are handled; other Triggers are not evaluated"],
			"modeOption.observe": ["评估其他触发并记录研判，但不接单", "Other Triggers are evaluated and Assessments recorded, but nothing is accepted"],
			"modeOption.auto": ["其他触发符合规则时接单", "Other Triggers that match a rule are accepted"],
			rulesHint: ["写明可以接什么、应忽略什么，也可以写明按这条规则接下的工单请谁审阅 PR。多条命中只接一单，有冲突或不明确时不接单。", "State what to accept and what to ignore, and optionally who reviews the PRs of Tickets accepted under the rule. Several matches accept once; conflicts or ambiguity accept nothing."],
			addRule: ["添加规则", "Add rule"],
			rulesEmpty: ["暂无规则，不会主动接单。", "No rules; nothing is accepted proactively."],
			ruleName: ["规则名称", "Rule name"],
			ruleInstruction: ["接单条件", "Acceptance condition"],
			ruleInstructionPlaceholder: ["例如：明确要求修正已有说明中的失效链接；不新增或改变产品承诺。", "For example: explicit requests to fix broken links in existing docs; no new product promises."],
			ruleEnable: ["启用规则：{name}", "Enable rule: {name}"],
			newRule: ["新规则", "New rule"],
			duplicate: ["复制", "Duplicate"],
			copySuffix: [" 副本", " copy"],
			evalTimeout: ["单次评估时限 / 秒", "Eval time limit / seconds"],
			evalTimeoutHint: ["主 Session 读取上下文并研判。到期后记为未完成，后续触发重新评估。", "The main Session reads context and assesses. When time runs out the Eval is unavailable and later Triggers are evaluated again."],
			evalIntro: ["评估决定一批触发是否成为工作：推断出的候选能否接单、评估时限和研判模型。", "Eval decides whether a batch of Triggers becomes work: whether inferred candidates may be accepted, the time limit, and the assessor model."],
			evalSettings: ["评估设置", "Eval settings"],
			policyIntro: ["评估依据的规则：接单规则，以及各来源上谁能发起工作。修改会生成新的策略版本，并通知进行中的工单。", "The rules Eval follows: the accept rules, and who may originate work on each Source. A change makes a new Policy version and notifies open Tickets."],
			assessorModel: ["研判模型", "Assessor model"],
			assessorModelHint: ["主 Session 的模型，负责研判和路由。保存后用于新建的主 Session，已有 Session 保持原选择。", "Model of the main Session, which assesses and routes. Applies to a newly created main Session; existing Sessions keep their choice."],
			ruleLabel: ["规则", "Rules"],
			"decisionFilter.work": ["接单与续做", "Accept and reopen"],
			"decisionFilter.stop": ["停止", "Stopped"],
			"decisionFilter.ignore": ["忽略", "Ignored"],
			"decisionFilter.unavailable": ["未完成", "Unavailable"],
			"decisionFilter.all": ["全部", "All"],
			lastDayOnly: ["仅过去 24 小时到达的触发 ✕", "Triggers from the last 24 hours only ✕"],
			evalStatusIntro: ["评估按策略对触发做出的决定，每条写明理由。", "The Decisions Eval made on Triggers under the Policy, each with its reason."],
			policyPerSource: ["在各来源上", "On each Source"],
			policyPerSourceHint: ["策略在每个来源上的部分：谁能通过这个来源发起工作，用这个来源自己的身份；不同来源之间不对应。要让智能体知道同一个人在各来源的账号，写在提示词里。", "The Policy's part on each Source: who may originate work through it, in that Source's own identities, with no mapping between Sources. To tell the agents a person's account on each Source, write it in the prompts."],
			explicitRequest: ["明确的请求", "Explicit request"],
			admission: ["准入", "Admission"],
			admissionHint: ["每个接收范围里，谁的什么消息算明确的请求、推断的候选，或被忽略。行来自来源设置里的接收范围。计入策略版本。", "For each receiving scope, whose messages are explicit requests, inferred candidates, or ignored. The rows come from the receiving scopes in the Source settings. Part of the Policy version."],
			admissionScope: ["接收范围", "Receiving scope"],
			admissionListed: ["名单内", "On the list"],
			admissionUnlisted: ["名单外", "Not on the list"],
			admissionAddressed: ["点名智能体", "Addresses the agent"],
			admissionUnaddressed: ["未 @", "No mention"],
			admissionNotReceived: ["这个范围收不到这类消息", "This scope does not receive these messages"],
			"admissionCell.listedUnaddressed": ["名单内 · 未 @", "On the list · no mention"],
			"admissionCell.unlistedAddressed": ["名单外 · 点名智能体", "Not on the list · addresses the agent"],
			"admissionCell.unlistedUnaddressed": ["名单外 · 未 @", "Not on the list · no mention"],
			"admissionValue.explicit": ["明确的请求", "Explicit request"],
			"admissionValue.inferred": ["推断的候选", "Inferred candidate"],
			"admissionValue.ignore": ["忽略", "Ignore"],
			admissionAnyoneWarning: ["这个范围里任何人点名智能体都能直接发起工作", "Anyone here who addresses the agent can originate work directly"],
			admissionFootnote: ["「推断的候选」按接单模式评估：模式为关闭时忽略。已有工单的线程里的跟进不看这张表。改成更弱的选项时，按这一格接下的进行中工单的授权失效。", "Inferred candidates follow the accept mode and are ignored when it is off. Follow-ups on Threads that have Tickets do not use this table. Weakening a cell revokes the Mandates of open Tickets accepted under it."],
			syncDone: ["上次同步", "Last synced"],
			evalRecordsPaused: ["处理已暂停：新的触发会被记录，但不会被评估。", "Processing is paused: new Triggers are recorded but not evaluated."],
			resumeWhere: ["在执行状态中恢复", "Resume in the Execution status"],
			"outcome.completed": ["已完成", "Completed"],
			"outcome.merged": ["PR 已合并", "Pull request merged"],
			"outcome.closed": ["PR 已关闭（未合并）", "Pull request closed unmerged"],
			"outcome.dropped": ["无需处理", "Nothing to do"],
			"outcome.stopped": ["人工停止", "Stopped by a person"],
			"assignment.pending": ["待启动", "Pending"],
			"assignment.running": ["执行中", "Running"],
			"assignment.ended": ["已结束", "Ended"],
			"report.queued": ["排队", "queued"],
			"report.running": ["执行中", "running"],
			"report.progress": ["进展", "progress"],
			"report.waiting": ["等待", "waiting"],
			"report.ready": ["就绪", "ready"],
			"report.blocked": ["受阻", "blocked"],
			"report.failed": ["失败", "failed"],
			"report.dropped": ["无需处理", "no action needed"],
			"report.completed": ["已完成", "completed"],
			"report.merged": ["已合并", "merged"],
			"report.closed": ["PR 已关闭", "PR closed"],
			"report.stopped": ["已停止", "stopped"],
			"report.open": ["进行中", "open"],
			"input.trigger": ["触发", "Trigger"],
			"input.policy-changed": ["策略变更", "Policy change"],
			"input.reopen": ["续做", "Reopened"],
			"input.resumed": ["恢复：线程上有人发了新消息", "Resumed by a new message on its thread"],
			"input.text": ["dsh-superagent 说明", "dsh-superagent note"],
			"input.note": ["主 Session 的备注", "Orchestrator note"],
			attentionPrefix: ["待人工决定：", "Attention: "],
			stopConfirmTitle: ["停止工单", "Stop Ticket"],
			stopConfirm: ["停止“{title}”？当前派工结束，Session 和执行目录保留；停止收回授权，之后线程里的消息不再恢复它，要继续需要重新接单。", "Stop \"{title}\"? Its current Assignment ends; its Session and directory stay. Stopping withdraws its Mandate: later messages on its Threads do not resume it, and continuing needs a new accept."],
			endedAt: ["{time} {outcome}：{reason}", "{time} {outcome}: {reason}"],
			assignmentNumber: ["第 {number} 次派工", "Assignment {number}"],
			inputDelivered: ["已送达", "Delivered"],
			inputPausedHint: ["未送达：处理已暂停，恢复后送达", "Undelivered: processing is paused; delivery resumes with it"],
			inputWaitingHint: ["未送达：等待派工运行", "Undelivered: waiting for the Assignment to run"],
			inputRetryHint: ["未送达：会自动重试，直到送达", "Undelivered: delivery is retried until it succeeds"],
			deliveryFailedPrefix: ["送达失败：", "Delivery failed: "],
			subscribedThreads: ["订阅的线程", "Subscribed Threads"],
			answerIn: ["去{source}回答", "Answer in {source}"],
			ticketNotFound: ["找不到这个工单。", "Ticket not found."],
			identifiers: ["标识", "Identifiers"],
			"basis.admission": ["准入", "Admission"],
			"basis.followup": ["线程内跟进", "Follow-up in Thread"],
			"basis.observation": ["接收全部消息的群", "Chat receiving all messages"],
			"basis.bot": ["名单内的机器人", "Listed bot"],
			"basis.mode": ["接单模式", "Accept mode"],
			"basis.rules": ["命中规则", "Matched rules"],
			"basis.legacyAuthority": ["旧版授权", "Legacy authority"],
			"legacy.explicit_mention": ["@ 智能体", "Mention"],
			"legacy.proactive_rule": ["主动规则", "Proactive rule"],
			"legacy.thread_followup": ["线程内跟进", "Thread follow-up"],
			ruleMatched: ["{rule} · 匹配：{reason}", "{rule} · matched: {reason}"],
			ruleUnmatched: ["{rule} · 不匹配：{reason}", "{rule} · not matched: {reason}"],
			directionLine: ["实施意图：{intent}；修改依据：{basis}；{design}", "Implementation intent: {intent}; target: {basis}; {design}"],
			intentYes: ["已明确", "established"],
			intentNo: ["未明确", "not established"],
			"targetBasis.specified": ["已明确目标", "specified"],
			"targetBasis.existing-standard": ["既有规范／已验证正确状态", "existing standard or verified correct state"],
			"targetBasis.undetermined": ["目标未定", "undetermined"],
			designNeeded: ["仍需产品／视觉设计决策", "a product or design decision remains"],
			designNotNeeded: ["无需新增设计决策", "no new design decision"],
			directionEvidence: ["方向证据：{evidence}", "Evidence: {evidence}"],
			maxWorkers: ["并行工单数", "Concurrent Tickets"],
			maxWorkersHint: ["超过并发上限的工单排队等待。", "Tickets beyond the limit wait in a queue."],
			"basis.sender": ["发起人", "Sender"],
			"basis.addressed": ["点名方式", "Addressed by"],
			"addressed.mention": ["@ 智能体", "Mention"],
			"addressed.direct": ["私聊", "Direct message"],
			executorIntro: ["执行器执行派工：每个工单一个执行器 Session 和执行目录。", "The Executor runs Assignments: one Executor Session and directory per Ticket."],
			executorModel: ["执行器模型", "Executor model"],
			executorModelHint: ["保存后用于新建的执行器 Session，已有 Session 保持原选择。留空继承 DSH 默认值。", "Applies to new Executor Sessions; existing Sessions keep their choice. Leave empty to inherit the DSH default."],
			assignmentReportShort: ["报告：{state}", "Report: {state}"],
			assignmentSpan: ["{from} → {to}", "{from} → {to}"],
			inputUndelivered: ["未送达", "Undelivered"],
			mandateDetails: ["授权详情", "Mandate details"],
			now: ["现在", "now"],
			stopHint: ["停止后当前派工结束，Session 和执行目录保留；停止收回授权，之后线程里的消息不再恢复它，要继续需要重新接单。", "Stopping ends the current Assignment; its Session and directory stay. Stopping withdraws its Mandate: later messages on its Threads do not resume it, and continuing needs a new accept."],
			idleHint: ["执行器结束了当前回合，没有提出问题；这些工单订阅的线程收到新触发时继续。", "The Executor ended its turn without asking anything; a new Trigger on a subscribed Thread resumes it."],
			"stage.staffing": ["待确认组队", "Team awaiting agreement"],
			"stage.answer": ["待回答", "Awaiting answer"],
			"stage.review": ["待验收", "Awaiting review"],
			"stage.blocked": ["待处理受阻", "Blocked"],
			"stage.failed": ["待处理失败", "Failed"],
			"stage.delivery": ["输入未送达", "Input undelivered"],
			"stage.queued": ["排队中", "Queued"],
			"stage.working": ["执行中", "Working"],
			"stage.idle": ["等待新触发", "Waiting for a Trigger"],
			deliveredInputs: ["已送达的输入 · {count}", "Delivered Inputs · {count}"],
			endedAtShort: ["{time} {outcome}", "{time} {outcome}"],
			legacyAssignment: ["原始说明", "Original brief"],
			legacyScopeShort: ["未记录（旧版导入）", "Not recorded (legacy import)"],
			retry: ["重试", "Retry"],
			failedPrefix: ["失败：", "Failed: "],
			blockedPrefix: ["受阻：", "Blocked: "],
			retryConfirm: ["为“{title}”结束当前派工并重新派工？授权和订阅不变。", "End the current Assignment of \"{title}\" and start a new one? Mandate and Subscriptions stay."],
			retryTitle: ["重试工单", "Retry Ticket"],
			undeliveredInputs: ["未送达的输入", "Undelivered Inputs"],
			executionStatusIntro: ["执行器的状态，以及按在等谁分组的工单。", "The Executor's state, and the Tickets grouped by who they wait on."],
			ticketUndeliveredLabel: ["未送达", "Undelivered"],
			ticketMandateLabel: ["授权", "Mandate"],
			ticketActorLabel: ["发起", "From"],
			ticketGroupLabel: ["执行群聊", "Group chat"],
			ticketUpdatedLabel: ["更新", "Updated"],
			executionDirectory: ["执行目录的根目录", "Ticket directory root"],
			executionDirectoryDefault: ["留空时用 {root}", "Empty uses {root}"],
			executionDirectoryEmpty: ["留空：默认目录", "Empty: the default directory"],
			openThread: ["打开 {source} 原文", "Open on {source}"],
			executionDirectoryHint: ["每个工单在这里有自己的目录，以工单短名命名；执行器 Session 在其中工作。这只按目录分开工单，不是安全边界。", "Each Ticket gets its own directory here, named by its short name, where its Executor Session works. This separates Tickets by directory only; it is not a security boundary."],
			prepareCommand: ["准备命令", "Prepare command"],
			prepareCommandHint: ["新工单的目录建好前，在根目录下用 sh 运行一次，执行环境的变量是它的环境变量，例如用 git worktree 把仓库检出到 $DSH_SUPERAGENT_DIR。留空就是空目录。失败时工单显示失败，并附上命令的输出。", "Runs once with sh in the root before a new Ticket's directory exists, with the execution environment's variables as its environment, for example to check a repository out to $DSH_SUPERAGENT_DIR with git worktree. Leave it empty for an empty directory. A failure fails the Ticket with the command's output."],
			prepareCommandEmpty: ["留空：空目录", "Empty: an empty directory"],
			blockedCommands: ["禁止调用的命令", "Blocked commands"],
			blockedCommandsHint: ["执行器 Session 调用这些命令名时直接失败，例如用你个人账号登录的 CLI。只拦按名字的调用，用绝对路径仍能运行，所以不是安全边界。gh、git、lark-cli 不能禁止。", "Command names that fail when an Executor Session calls them, such as a CLI signed in to your own account. Only calls by name fail; an absolute path still runs, so this is not a security boundary. gh, git and lark-cli cannot be blocked."],
			blockedCommandsNone: ["以空格分隔；没有", "Separated by spaces; none"],
			environmentIntro: ["执行器和各来源向执行环境登记变量，每个有键、值和说明。准备命令以环境变量读取它们，执行器 Session 在指令里读到它们和说明。工单自己的值来自它的目录和接下它的触发，其余是部署的当前值；不含任何密钥。只能在管理页修改。", "The Executor and the Sources register variables with the execution environment, each with a key, a value and a description. The prepare command reads them as environment variables, and the Executor Session reads them with their descriptions in its instructions. A Ticket's own values follow from its directory and the Trigger that started it; the others are the deployment's current values. None holds a credential. Only the management page can change these settings."],
			environmentVariables: ["可用的环境变量", "Available variables"],
			environmentPick: ["点击键名插入到准备命令。", "Choose a key to insert it into the prepare command."],
			environmentKey: ["键", "Key"],
			environmentDescription: ["说明", "Description"],
			environmentOwner: ["注册者", "Registered by"],
			executorRunning: ["执行器运行中", "Executor running"],
			pauseProcessing: ["暂停处理", "Pause processing"],
			pauseProcessingConfirm: ["暂停后，来源继续记录触发，但不开始新的评估、不派工、不发送回复，直到恢复。", "While paused, Sources keep recording Triggers, but no Evals or Assignments start and no replies are sent until processing resumes."],
			processingPaused: ["处理已暂停", "Processing paused"],
			"ticketFilter.open": ["进行中", "Open"],
			"ticketFilter.person": ["待处理", "Pending"],
			"ticketFilter.working": ["执行中", "Working"],
			"ticketFilter.idle": ["等待新触发", "Waiting for a Trigger"],
			"ticketFilter.ended": ["已结束", "Ended"],
			policyVersionUnrecorded: ["最近的保存记录里没有策略版本 {version}：它来自更早的保存、首次启动时的设置或更早的数据。", "The recent saves do not include Policy version {version}: an older save, the settings at the first start, or older data made it."],
			defaultModel: ["DSH 当前默认：{model}", "DSH default: {model}"],
			defaultModelUnavailable: ["DSH 默认模型暂不可用", "DSH default model unavailable"],
			modelProvider: ["服务商", "Provider"],
			modelName: ["模型", "Model"],
			modelEffort: ["推理强度（可选）", "Reasoning effort (optional)"],
			modelInherit: ["继承 DSH 默认值", "Inherit the DSH default"],
			modelEffortDefault: ["模型默认", "Model default"],
			modelCatalogError: ["无法加载模型建议，仍可填写已知的服务商和模型：{error}", "Model suggestions are unavailable; known Provider and Model names still work: {error}"],
			historyIntro: ["每次保存记一条；改变策略版本的保存（接单规则、各来源上的策略、接单模式）通知进行中的工单。", "Each save is one entry; saves that change the Policy version (rules, the Policy on each Source, accept mode) notify open Tickets."],
			historyItem: ["第 {revision} 次保存 · {source}", "Save {revision} · {source}"],
			historyPolicyChanged: ["生成策略版本 {version}", "New Policy version {version}"],
			historyNoBaseline: ["上一个设置版本没有记录，无法比较。", "The previous revision was not recorded; nothing to compare."],
			historyNoChanges: ["当前设置项没有变化。", "No change to current settings."],
			historyNotified: ["因策略变更通知了 {count} 个进行中的工单：{titles}", "Policy change notified {count} open Tickets: {titles}"],
			historyEmpty: ["还没有记录的版本；下次保存后开始记录。", "No revisions recorded yet; history starts with the next save."],
			"change.mode": ["接单模式：{from} → {to}", "Accept mode: {from} → {to}"],
			"change.timeout": ["评估时限：{from} → {to} 秒", "Eval time limit: {from} → {to} s"],
			"change.ruleAdded": ["新增规则：{name}", "Rule added: {name}"],
			"change.ruleRenamed": ["规则改名：{from} → {to}", "Rule renamed: {from} → {to}"],
			"change.ruleInstruction": ["规则条件修改：{name}", "Rule condition changed: {name}"],
			"change.ruleEnabled": ["规则启用：{name}", "Rule enabled: {name}"],
			"change.ruleDisabled": ["规则停用：{name}", "Rule disabled: {name}"],
			"change.ruleRemoved": ["删除规则：{name}", "Rule removed: {name}"],
			"change.paused": ["暂停处理", "Processing paused"],
			"change.resumed": ["恢复处理", "Processing resumed"],
			"change.maxWorkers": ["并行工单数：{from} → {to}", "Concurrent Tickets: {from} → {to}"],
			"change.executionDirectory": ["执行目录的根目录：{from} → {to}", "Ticket directory root: {from} → {to}"],
			"change.prepareCommand": ["准备命令", "Prepare command"],
			"change.blockedCommands": ["禁止调用的命令：{from} → {to}", "Blocked commands: {from} → {to}"],
			configHistory: ["配置历史", "Configuration history"],
			"change.evalModel": ["研判模型", "Assessor model"],
			"change.executorModel": ["执行器模型", "Executor model"],
			"change.sourceEnabled": ["启用来源：{source}", "Source enabled: {source}"],
			"change.sourceDisabled": ["停用来源：{source}", "Source disabled: {source}"],
			"change.sourceAdmission": ["{source} · 准入修改", "{source} · admission changed"],
			"change.sourceField": ["{source} · {field}：{from} → {to}", "{source} · {field}: {from} → {to}"],
			"change.sourceRowsAdded": ["{source} · {field} 新增：{items}", "{source} · {field} added: {items}"],
			"change.sourceRowsRemoved": ["{source} · {field} 移除：{items}", "{source} · {field} removed: {items}"],
			"change.sourceRowsChanged": ["{source} · {field} 修改：{items}", "{source} · {field} changed: {items}"],
			draftRestored: ["未保存 · 已恢复草稿", "Unsaved · draft restored"],
			draftKept: ["未保存 · 草稿已保留", "Unsaved · draft kept"],
			draftFailed: ["无法保留草稿，请保存后再离开：{error}", "Could not keep the draft; save before leaving: {error}"],
			save: ["保存", "Save"],
			discard: ["放弃修改", "Discard changes"],
			saveConflict: ["设置已在别处修改，其中有你也改过的项；保存会以你的修改为准。", "Settings changed elsewhere, including items you changed too; saving keeps your version of them."],
			saveMerged: ["设置已在别处修改，你的修改已合并到最新版本；请检查后保存。", "Settings changed elsewhere; your changes are merged onto the latest version. Check them, then save."],
			saveRebasing: ["已在别处修改，正在读取最新版本…", "Changed elsewhere; reading the latest version…"],
			invalidSettings: ["这些字段无效：{fields}", "Invalid fields: {fields}"],
			"settingsGroup.source": ["来源", "Sources"],
			"settingsGroup.eval": ["评估", "Eval"],
			"settingsGroup.execution": ["执行", "Execution"],
			"settingsGroup.prompts": ["提示词", "Prompts"],
			"settingsGroup.deployment": ["部署", "Deployment"],
			unsetValue: ["未设置", "not set"],
			promptChanges: ["{count} 处修改", "{count} changes"],
			unsaved: ["未保存", "Unsaved"],
			promptsDraftVersion: ["未保存 · 基于版本 {revision}", "Unsaved · based on version {revision}"],
			"promptPart.runtime/admission": ["主 Session 接单约束", "Main Session accept constraints"],
			"promptPart.runtime/policy": ["策略与启用的规则", "Policy and enabled rules"],
			"promptPart.runtime/handoff/orchestrator": ["工单交付与人工确认（主 Session）", "Ticket handoff and human confirmation (main Session)"],
			"promptPart.runtime/handoff/worker": ["工单交付与人工确认（执行器）", "Ticket handoff and human confirmation (Executor)"],
			"promptPart.runtime/policy/none": ["策略（没有启用的规则时）", "Policy (when no rule is enabled)"],
			"promptPart.skill/feishu": ["飞书技能", "Feishu skill"],
			"promptPart.skill/github": ["GitHub 技能", "GitHub skill"],
			"promptPart.runtime/environment": ["执行环境", "Execution environment"],
			promptViewEdit: ["编辑", "Edit"],
			promptViewFull: ["完整提示词", "Full prompt"],
			promptViewHistory: ["历史", "History"],
			promptSections: ["提示词段落", "Prompt sections"],
			promptTeamGroup: ["团队约定", "Team agreements"],
			promptSkillsGroup: ["技能", "Skills"],
			"promptPartHint.communication": ["何时通知人、消息的写法、GitHub 首行声明、Review 的回复与 review bot", "When to notify people, how messages read, the GitHub first line, review replies and review bots"],
			"promptPartHint.scope": ["工单何时继续、何时暂停并交草稿", "When a Ticket goes on, and when it stops with a draft"],
			"promptPartHint.delivery": ["PR 证据、自动合并条件、提交作者", "PR evidence, the auto-merge condition, the commit author"],
			"promptReadBy.both": ["主 Session 和执行器 Session 都会读到。", "The main Session and Executor Sessions read it."],
			"promptReadBy.skill": ["Session 需要时按名字加载。", "Sessions load it by name when they need it."],
			"promptReadBy.orchestrator": ["只有主 Session 会读到。", "Only the main Session reads it."],
			"promptReadBy.worker": ["只有执行器 Session 会读到。", "Only Executor Sessions read it."],
			promptBuiltInGroup: ["内置段落", "Built-in parts"],
			promptTemplateHint: ["这是模板：保留占位符 {placeholders}，由系统填入内容。", "A template: keep the placeholders {placeholders}, which the system fills in."],
			promptDefaultUpdated: ["默认内容已更新", "Default updated"],
			promptDefaultUpdatedHint: ["升级改了这一段的默认内容，你的文本保持不变。", "An upgrade changed the default of this part; your text stays as it is."],
			promptDefaultUpdatedKnown: ["下面是默认内容的变化。", "Below is how the default changed."],
			promptDefaultUpdatedUnknown: ["系统没有记录你编辑时的默认内容；下面是你的文本与新默认内容的对比。", "The default you edited from was not recorded; below, your text against the new default."],
			promptRemovedParts: ["当前插件版本已没有这些段落，你为它们写的文本不再使用，下次保存时移除：{parts}", "This version no longer has these parts; your text for them is unused and goes at the next save: {parts}"],
			promptKeepMine: ["保留我的文本", "Keep my text"],
			promptTakeDefault: ["改用新的默认内容", "Use the new default"],
			promptFullState: ["共 {count} 段 · {chars} 字符 · {state}", "{count} sections · {chars} characters · {state}"],
			promptCopyAll: ["复制全文", "Copy all"],
			promptChanged: ["已改", "Changed"],
			promptCompare: ["比较对象", "Compare with"],
			promptCompareSaved: ["与已保存比较", "Against saved"],
			promptCompareDefault: ["与默认比较", "Against defaults"],
			promptBuiltInFolded: ["按当前设置生成，不参与比较。", "Generated from the current settings; not compared."],
			promptSameAsSaved: ["与已保存相同。", "Same as saved."],
			promptSameLines: ["… 相同的 {count} 行 …", "… {count} unchanged lines …"],
			copied: ["已复制", "Copied"],
			promptPartTeam: ["团队约定", "Team agreement"],
			promptPartFixed: ["内置", "Built in"],
			promptPartGenerated: ["内置 · 按当前设置生成", "Built in · from the current settings"],
			"promptPart.communication": ["沟通方式", "Communication"],
			"promptPart.scope": ["工单范围", "Ticket scope"],
			"promptPart.delivery": ["交付要求", "Delivery requirements"],
			"promptPart.legacy": ["早期版本的完整配置（载入后是内置文本加它的技能）", "A complete configuration of an earlier version (loading it gives the built-in text and its skills)"],
			"promptPart.runtime/shared": ["共享约定", "Shared rules"],
			"promptPart.runtime/orchestrator": ["主 Session 角色", "Main Session role"],
			"promptPart.runtime/worker": ["执行器角色", "Executor role"],
			"promptPart.runtime/subscriptions": ["订阅", "Subscriptions"],
			"promptPart.runtime/replies": ["回复与确认", "Replies and acknowledgements"],
			"promptPart.runtime/dispatch": ["路由", "Routing"],
			"promptPart.runtime/work": ["执行", "Execution"],
			promptViews: ["查看方式", "View"],
			promptBody: ["Markdown 正文", "Markdown"],
			promptResetSection: ["恢复此段默认内容", "Restore this section default"],
			promptPreviewTarget: ["预览目标", "Preview target"],
			promptPreviewDraft: ["未保存草稿", "unsaved draft"],
			promptPreviewSaved: ["版本 {revision}", "version {revision}"],
			promptEditSource: ["编辑此段", "Edit section"],
			promptHistoryHint: ["载入会替换整套草稿：三个团队段落和团队技能；保存后才生效。", "Loading replaces the whole draft: the three team sections and the team skills; nothing changes until you save."],
			promptHistoryItem: ["版本 {revision} · {time} · {source}", "Version {revision} · {time} · {source}"],
			promptHistoryInitial: ["初始版本", "initial"],
			promptHistoryChanged: ["修改段：{parts}", "Changed: {parts}"],
			promptHistoryNone: ["初始版本或无内容变化", "Initial version or no content change"],
			promptOlder: ["更早版本", "Older versions"],
			promptRestore: ["将这个版本载入草稿", "Load this version into the draft"],
			promptDefaults: ["将整套默认内容载入草稿", "Load all defaults into the draft"],
			promptDraftFromHistory: ["整套草稿来自历史版本 {revision}；保存将创建新版本", "Draft loaded from version {revision}; saving creates a new version"],
			promptDraftFromDefaults: ["整套草稿来自当前插件默认值", "Draft loaded from the current plugin defaults"],
			promptDraftSectionReset: ["已恢复此段默认内容：{part}", "Restored the default of: {part}"],
			promptAddSkill: ["添加自定义技能", "Add a custom skill"],
			promptSkillName: ["名称，例如 testing", "Name, e.g. testing"],
			promptAddSkillAction: ["添加到草稿", "Add to draft"],
			promptSkillNameInvalid: ["技能名称须唯一，仅使用小写字母、数字和连字符，以字母开头。", "Skill names must be unique, start with a letter, and use lowercase letters, digits and hyphens."],
			promptConflict: ["提示词已被修改到版本 {revision}。已保留你的草稿；请比较后重新保存。", "Prompts changed to version {revision}. Your draft is kept; compare and save again."],
			promptConflictParts: ["提示词已被修改到版本 {revision}，其中 {parts} 你也改过；保存会以你的版本为准。", "Prompts changed to version {revision}, including {parts}, which you changed too; saving keeps your version."],
			promptSavedPending: ["已保存；通知等待注入主 Session。", "Saved; the notice is waiting to reach the main Session."],
			promptSessions: ["Session 最近使用的版本", "Versions used by Sessions"],
			promptSessionItem: ["{session}：版本 {revision}", "{session}: version {revision}"],
			promptNoSessions: ["暂无模型请求", "No model requests yet"],
			"promptRole.orchestrator": ["主 Session", "Main Session"],
			"promptRole.worker": ["执行器 Session", "Executor Session"],
			deploymentIntro: ["这台机器上的 dsh-superagent 设置，存放在 DSH 配置文件的 dsh-superagent 条目里；保存后立即生效，不会重启 dsh-superagent。", "dsh-superagent's settings on this machine, kept in the dsh-superagent entry of the DSH configuration; a saved change applies at once, without restarting dsh-superagent."],
			deploymentUnavailable: ["dsh-superagent 启动完成后才能修改这些值。", "These values can be changed once dsh-superagent has started."],
			deploymentDerived: ["仓库与账号", "Repository and accounts"],
			deploymentDerivedHint: ["由来源设置里的仓库和 CLI 得出。", "Derived from the repository and the CLIs in the Source settings."],
			deploymentRepository: ["仓库", "Repository"],
			deploymentAgent: ["智能体账号", "Agent account"],
			deploymentFeishu: ["飞书机器人", "Feishu bot"],
			deploymentFeishuNone: ["未设置", "Not set"],
			deploymentAccountsWhere: ["账号在 dsh-superagent 面板的来源设置里修改。", "Accounts are changed in the Source settings of the dsh-superagent panel."],
			deploymentMachine: ["本机设置", "This machine"],
			deploymentStateDir: ["状态目录", "State directory"],
			deploymentStateDirHint: ["数据库、锁、执行器的命令和智能体的 git 配置所在目录，只能在 DSH 配置文件里修改。", "Holds the database, locks, the Executor's commands and the agent's git configuration; change it only in the DSH configuration file."],
			deploymentLimits: ["上限", "Limits"],
			deploymentLimitsHint: ["本机资源的上限：保存的提示词最长多少字，评估读取线程上下文时最多读几页、每次读取最多等多久。", "Resource limits on this machine: how long a saved prompt may be, and how many Thread pages Eval may read and how long one read may take."],
			deploymentPromptMaxChars: ["提示词配置的最大字符数", "Largest prompt configuration / characters"],
			deploymentContextPages: ["一次研判可读的线程页数", "Thread pages one Assessment may read"],
			deploymentContextTimeout: ["一次上下文读取的时限 / 毫秒", "Time limit of one context read / ms"],
			deploymentRefused: ["DSH 拒绝了这次修改：设置可能已在别处修改。放弃修改后可看到当前值。", "DSH refused the change; the settings may have changed elsewhere. Discard to see the current values."],
			deploymentNoForms: ["这个 DSH 版本不提供配置表单，这些值只能在 DSH 配置文件的 dsh-superagent 条目里修改。", "This DSH version has no configuration forms; change these values in the dsh-superagent entry of the DSH configuration file."],
			deploymentReadOnly: ["只有本机上的浏览器可以修改这些值。", "Only a browser on this machine can change these values."],
			setupCheck: ["重新检查", "Check again"],
			setupChecking: ["正在重新检查，dsh-superagent 正在重启", "Checking again; dsh-superagent is restarting"],
			setupCheckInterrupts: ["重新检查会重启 dsh-superagent：{count} 个进行中的派工会中断，并带恢复说明重新开始。", "Checking again restarts dsh-superagent: {count} running Assignments stop and start again with a recovery note."],
			"reason.not_human": ["自动消息", "Automated message"],
			"reason.not_a_member": ["发送者不在这个来源的名单里", "Sender is not on this Source's list"],
			"reason.no_mention": ["没有点名智能体，且这个来源不接收其余消息", "Does not address the agent, and this Source does not receive the rest"],
			"reason.admission_ignored": ["准入设为忽略", "Admission set to ignore"],
			"reason.chat_not_allowed": ["群不在监听的群里", "Chat is not a listened chat"],
			"reason.direct_messages_not_allowed": ["私聊未开放", "Direct messages are off"],
			"reason.observation_only": ["仅观察的群（旧版过滤）", "Observe-only chat (legacy filter)"],
			"reason.untracked_source": ["线程未被订阅", "Thread not subscribed"],
			"reason.issue_assigned": ["Issue 已有负责人", "Issue has an assignee"],
			"reason.issue_closed": ["Issue 已关闭", "Issue is closed"],
			"reason.issue_has_pull_request": ["Issue 已有关联 PR", "Issue has a linked PR"],
			"reason.issue_unclaimed_less_than_day": ["Issue 无人认领未满一天", "Issue unclaimed for less than a day"],
			"reason.task_ended": ["工单已结束", "Ticket ended"],
			"reason.task_paused": ["工单已暂停", "Ticket paused"],
			"reason.subscription_inactive": ["订阅未生效", "Subscription inactive"],
			"reason.subscription_removed": ["订阅已移除", "Subscription removed"],
			"reason.issue_awaiting_eligibility": ["等待 Issue 满足资格", "Waiting for Issue eligibility"],
			"reason.timeout": ["评估超时未决定", "Eval timed out"],
			"reason.policyChanged": ["评估期间策略已变更", "Policy changed during the Eval"],
			"reason.noAdmissible": ["没有可准入的触发", "No admissible Trigger"],
			"reason.startedTicket": ["已经开过工单 {ticket}", "Already started Ticket {ticket}"],
			"reason.acceptedBefore": ["触发 {trigger} 之前已接单", "Trigger {trigger} was accepted before"],
			"reason.routed": ["已转给工单 {ticket}", "Routed to Ticket {ticket}"],
			"reason.stopUnknown": ["要停止的工单不存在或已结束", "The Ticket to stop is unknown or ended"],
			"reason.stopNotExplicit": ["停止需要名单里的人明确要求", "Stopping needs an explicit request from someone on the list"],
			"reason.directionUnsettled": ["实现意图或目标未确定，或还要产品或设计决定", "Intent or target not settled, or a product or design decision is still open"],
			"reason.noRuleMatched": ["没有启用的准入规则匹配", "No enabled admission rule matched"],
			"reason.ignoredFromCard": ["仅凭候选卡片忽略，未经规则研判", "Ignored from its card, without a rule assessment"],
			"reason.observed": ["观察模式：本会接单（{text}）", "Observe mode: would accept ({text})"],
			"reason.explicitRouted": ["名单里的人明确请求，由主 Session 接单", "Explicit request from someone on the list, accepted by the main Session"],
			"reason.legacyImport": ["从旧版工单记录导入", "Imported from a legacy Ticket record"],
			"reason.channelGone": ["对话已无法接收消息", "The conversation can no longer receive messages"],
			"reason.channelIgnored": ["来源已不再监听这个对话", "The Source no longer listens to this conversation"],
			"reason.hostRestarted": ["dsh-superagent 重启", "dsh-superagent restarted"],
			"reason.retried": ["人工重试", "Retried by a person"],
			"reason.completed": ["已完成", "Completed"],
			"reason.dropped": ["无需处理，已关闭", "No action needed; closed"],
			"reason.merged": ["PR 已合并", "PR merged"],
			"reason.closed": ["PR 已关闭", "PR closed"],
			"reason.stopped": ["人工停止", "Stopped by a human"],
			"reason.revoked": ["授权已失效", "Mandate no longer valid"],
			"reason.humanStop": ["有人要求停止", "Someone asked to stop"],
			"reason.forwarded": ["已扇出给该线程的工单", "Fanned out to the Thread's Ticket"],
			"reason.senderNotMember": ["发送者不在这个来源的名单里", "Sender is not on this Source's list"],
			"reason.source_disabled": ["来源已停用", "Source disabled"],
			"reason.superagent_desk_off": ["没有接收主管对话", "The supervisor desk is not received"],
			"reason.superagent_bots_off": ["没有接收 bot 求助", "Bots asking for help are not received"],
			"reason.superagent_unknown": ["不是主管对话，也不是 bot 求助", "Neither the supervisor desk nor a Bot asking for help"],
			"reason.issue_sender_or_admission_disabled": ["Issue 发起人不在名单或主动接单已关闭", "Issue sender not on the list, or proactive accept off"],
			"reason.source_not_installed": ["来源插件未加载", "Source plugin not loaded"],
			"reason.issue_unclaimed_less_than_wait": ["Issue 无人认领未满等待时长", "Issue unclaimed for less than the wait"],
			glossary: ["术语表", "Glossary"],
			glossaryIntro: ["界面只显示一种语言；文档、代码和工具使用英文术语。", "The interface shows one language; documents, code and tools use the English terms."],
			glossaryChinese: ["中文", "中文"],
			glossaryEnglish: ["English", "English"],
			glossaryMeaning: ["含义", "Meaning"],
			"term.source": ["来源", "Source"],
			"term.trigger": ["触发", "Trigger"],
			"term.thread": ["线程", "Thread"],
			"term.correlation": ["关联", "Correlation"],
			"term.channel": ["渠道", "Channel"],
			"term.policy": ["策略", "Policy"],
			"term.eval": ["评估", "Eval"],
			"term.gate": ["准入", "Gate"],
			"term.assessment": ["研判", "Assessment"],
			"term.decision": ["决定", "Decision"],
			"term.mandate": ["授权", "Mandate"],
			"term.ticket": ["工单", "Ticket"],
			"term.assignment": ["派工", "Assignment"],
			"term.subscription": ["订阅", "Subscription"],
			"term.fanout": ["扇出", "Fan-out"],
			"term.executor": ["执行器", "Executor"],
			"term.report": ["报告", "Report"],
			"term.attention": ["待人工决定", "Attention"],
			"term.disposition": ["去向", "Disposition"],
			"term.input": ["输入", "Input"],
			"term.scope": ["范围", "Scope"],
			"term.strength": ["强度", "Strength"],
			"term.agent": ["智能体", "Agent"],
			"term.mainSession": ["主 Session", "Main Session"],
			"term.executorSession": ["执行器 Session", "Executor Session"],
			"term.policyVersion": ["策略版本", "Policy version"],
			"meaning.agent": ["以 dsh-superagent 身份工作的虚拟同事：通过 GitHub 账号、飞书机器人等身份在来源上行动", "The virtual colleague dsh-superagent runs: it acts on the Sources through its identities, such as a GitHub account or a Feishu bot"],
			"meaning.mainSession": ["评估触发、接单派工并回复的 DSH Session；提示词里称 orchestrator", "The DSH Session that evaluates Triggers, accepts and dispatches work, and replies; prompts call it the orchestrator"],
			"meaning.executorSession": ["执行器为一个工单运行的 DSH Session；提示词里称 worker", "The DSH Session the Executor runs for one Ticket; prompts call it the worker"],
			"meaning.policyVersion": ["接单规则、各来源上的策略和接单模式的一个组合的标识；每个工单记下接单时的版本", "The identifier of one combination of rules, the Policy on each Source and accept mode; each Ticket records the version it was accepted under"],
			"glossaryGroup.roles": ["角色", "Roles"],
			"meaning.source": ["产生触发的事件流；由插件提供的类型加一份配置（是否运行、监听什么）", "An event stream that produces Triggers; a plugin-provided kind plus one configuration (whether it runs, what it listens to)"],
			"meaning.trigger": ["来源产生的单个不可变事件", "One immutable event produced by a Source"],
			"meaning.thread": ["按时间排列的触发；同一时间只有一个评估", "Triggers in time order; one Eval at a time"],
			"meaning.correlation": ["一个触发同属多个线程时线程之间的关系，只用来补充上下文", "Relation between Threads that share a Trigger; context only"],
			"meaning.channel": ["线程的只写端，用于回复", "The write-only side of a Thread, for replies"],
			"meaning.policy": ["版本化的接单规则和各来源上的名单；决定谁能发起工作、接什么", "Versioned rules and each Source's list; decides who may originate work and what is accepted"],
			"meaning.eval": ["对一批触发做出决定的过程", "The process that turns a batch of Triggers into a Decision"],
			"meaning.gate": ["评估的第一层：谁能发起工作、强度多少", "First Eval layer: who may originate work, and how strongly"],
			"meaning.assessment": ["评估中的模型语义判断", "Eval step where the model judges meaning"],
			"meaning.decision": ["评估的结果", "The result of an Eval"],
			"meaning.mandate": ["接单时产出的授权：强度、范围、依据的策略版本", "Authorization produced by accept: strength, scope and Policy version"],
			"meaning.ticket": ["被授权的工作单位", "An authorized unit of work"],
			"meaning.assignment": ["工单与一个执行器 Session 的绑定", "Binding of a Ticket to one Executor Session"],
			"meaning.subscription": ["工单与线程的关系；主 Session 只在消息明确指向某个工单时才把线程关联给它，执行器可以退订与本工单无关的线程", "Relation between a Ticket and a Thread; the main Session attaches a Thread only when its message points at the Ticket, and the Executor can drop a Thread unrelated to its Ticket"],
			"meaning.fanout": ["订阅线程上的触发作为上下文送达工单，不带授权", "Triggers on a subscribed Thread reach the Ticket as context, without authority"],
			"meaning.executor": ["执行派工的一方：每个工单一个执行器 Session 和执行目录", "What runs Assignments: one Executor Session and directory per Ticket"],
			"meaning.report": ["派工向工单回报的状态", "State an Assignment reports to its Ticket"],
			"meaning.attention": ["工单上等待人回答的问题", "A question on a Ticket waiting for a human"],
			"meaning.disposition": ["一个触发被过滤、评估、扇出的记录", "Where a Trigger went: filtered, evaluated, fanned out"],
			"meaning.input": ["送达工单的上下文（扇出的触发、策略变更、恢复、文本）", "Context delivered to a Ticket (fanned-out Triggers, Policy changes, resumes, text)"],
			"meaning.scope": ["授权允许的工作范围", "The work a Mandate allows"],
			"meaning.strength": ["授权与评估的依据强度", "How strong the grounds of a Mandate or Eval are"],
			legendTitle: ["状态颜色", "Status colors"],
			"legend.done": ["完成、就绪或已接单", "Done, ready or accepted"],
			"legend.ongoing": ["执行中或评估中", "Running or evaluating"],
			"legend.warning": ["等待、受阻或需要人", "Waiting, blocked or needs a person"],
			"legend.error": ["失败或异常", "Failed or failing"],
			"legend.idle": ["已结束、已停用或无后续", "Ended, disabled or no follow-up"],
			"term.environment": ["执行环境", "Execution environment"],
			"meaning.environment": ["每个工单的执行器 Session 和准备命令运行的环境：执行器和各来源登记的变量，每个有键、值和说明", "Where a Ticket's Executor Session and prepare command run: the variables the Executor and the Sources register, each with a key, a value and a description"],
			"userError.unknownTicket": ["找不到这个工单。", USER_ERRORS.unknownTicket[1]],
			"userError.unknownProblem": ["找不到这个未完成的评估。", USER_ERRORS.unknownProblem[1]],
			"sourceUncertainTitle": ["不确定是否已发出", "Not known whether sent"],
			"sourceUncertainHint": ["发送时超时、被中断或 SuperAgent 停了，可能已经发出。为免重复不会自动重发：先到对话里看一眼，确实没收到再点「重投」。", "Sending timed out, was cut off, or SuperAgent stopped: it may have gone out. It is not sent again by itself; check the conversation, and redeliver only if it did not arrive."],
			"sourceRedeliver": ["重投", "Redeliver"],
			"userError.notUnknownReply": ["这条消息不在等你重投（可能已经重投过）。", USER_ERRORS.notUnknownReply[1]],
			"userError.unknownTrigger": ["找不到这个触发。", USER_ERRORS.unknownTrigger[1]],
			"userError.unknownAssignment": ["找不到这个派工。", USER_ERRORS.unknownAssignment[1]],
			"userError.unknownBlock": ["没有这个设置块：{block}", USER_ERRORS.unknownBlock[1]],
			"userError.unknownPromptRevision": ["没有提示词版本 {revision}。", USER_ERRORS.unknownPromptRevision[1]],
			"userError.unknownPromptPart": ["没有内置提示词段落 {part}。", USER_ERRORS.unknownPromptPart[1]],
			"userError.ticketEnded": ["工单已结束。", USER_ERRORS.ticketEnded[1]],
			"userError.notStaffing": ["这张工单不在等待组队，团队已经同意过了。", USER_ERRORS.notStaffing[1]],
			"userError.staleProposal": ["同意的不是当前版本的组队方案，请按最新版本确认。", USER_ERRORS.staleProposal[1]],
			"userError.notConsent": ["只有名单里的人在工单线程上、方案发出之后亲自发的消息才能同意或拒绝组队；{why}", USER_ERRORS.notConsent[1]],
			"userError.assignmentEnded": ["这个派工已结束，工单已由较新的派工接手。", USER_ERRORS.assignmentEnded[1]],
			"userError.evalFinished": ["评估 {eval} 已结束，或已被之后的评估取代；请对这个触发当前的评估做决定。", USER_ERRORS.evalFinished[1]],
			"userError.notAdmissible": ["这个触发未通过准入：{reason}", USER_ERRORS.notAdmissible[1]],
			"userError.notExplicit": ["通过 orchestrator_route 接单只用于名单内发送者的明确请求；主动接单的候选请用 orchestrator_eval 和 orchestrator_eval_decide 研判。", USER_ERRORS.notExplicit[1]],
			"userError.ticketStopped": ["有人停止了这个工单；新工作需要通过 orchestrator_route 接单。", USER_ERRORS.ticketStopped[1]],
			"userError.mandateRevoked": ["按当前策略，这个工单的授权已失效；新工作需要通过 orchestrator_route 接单。", USER_ERRORS.mandateRevoked[1]],
			"userError.notRetryable": ["只有进行中的工单可以重试，而且仅当执行器最近一次报告为失败或受阻且此后没有人发过消息，或者向执行器送达输入失败时才可以。", USER_ERRORS.notRetryable[1]],
			"userError.sourceThread": ["这是工单开始时所在的线程，会保持订阅。", USER_ERRORS.sourceThread[1]],
			"userError.followedThread": ["这是工单自己的线程，例如它的 PR，会保持订阅。", USER_ERRORS.followedThread[1]],
			"userError.notFollowing": ["这个工单没有订阅那个线程。", USER_ERRORS.notFollowing[1]],
			"userError.questionWithResult": ["给人的问题不能同时是就绪的结果或回答，请分开报告。", USER_ERRORS.questionWithResult[1]],
			"userError.askerWithoutQuestion": ["提出问题的消息需要附上它提出的问题。", USER_ERRORS.askerWithoutQuestion[1]],
			"userError.notAsker": ["问题必须指明提出它的那条人发的消息，且那条消息已送达这个工单。", USER_ERRORS.notAsker[1]],
			"userError.notAnswerable": ["回答必须指明它所回答的、由人提出的问题，且这个问题已送达这个工单。", USER_ERRORS.notAnswerable[1]],
			"userError.ackEnded": ["工单已结束，不要确认过去的请求。", USER_ERRORS.ackEnded[1]],
			"userError.notReached": ["这个触发不属于这个执行器。", USER_ERRORS.notReached[1]],
			"userError.handedBack": ["这个工单已经交回过这个触发。", USER_ERRORS.handedBack[1]],
			"userError.handedBackHere": ["这个工单的执行器已把这个触发交回，认为它超出本工单的范围：请把它作为新工作接单、关联到另一个工单，或忽略它。", USER_ERRORS.handedBackHere[1]],
			"userError.workerDecides": ["这条消息已通过所在线程送达工单 {tickets}：由工单的执行器判断它是否属于这个工单，不属于的会被交回，之后作为候选到达。只有停止例外，用 orchestrator_route 并把 kind 设为 stop。", USER_ERRORS.workerDecides[1]],
			"userError.ackNoChannel": ["确认需要一条已派给这个执行器、由人发出的原始消息。", USER_ERRORS.ackNoChannel[1]],
			"userError.ackNotPerson": ["请使用最初那条人发的触发，而不是机器人、CI 或执行器的报告。", USER_ERRORS.ackNotPerson[1]],
			"userError.notReady": ["工单还不能交付。进展只在内部保留，等待经过验证的就绪报告；不要把进展当作回答，也不要通过其他渠道发送。", USER_ERRORS.notReady[1]],
			"userError.notAttention": ["待人工决定的消息需要在 human_action 中写明工单当前待人工决定的问题。日常未完成的工作只在内部保留。", USER_ERRORS.notAttention[1]],
			"userError.notQuestion": ["回答必须针对最初由人提出的问题，而不是执行器报告或自动触发。", USER_ERRORS.notQuestion[1]],
			"userError.noAnswer": ["执行器还没有回答这条人发的触发。请等待执行器的报告，或用 orchestrator_ticket_request_status 请求一份（它只对处于等待状态的执行器起作用）；普通进展不能当作回答。", USER_ERRORS.noAnswer[1]],
			"userError.noChannel": ["这个工单或触发没有可以回复的渠道。", USER_ERRORS.noChannel[1]],
			"userError.panelOnlyEnvironment": ["执行环境（执行目录、准备命令、禁止调用的命令）只能在管理页修改。", USER_ERRORS.panelOnlyEnvironment[1]],
			"userError.panelOnlyAccounts": ["部署检查读取的来源字段（例如账号 CLI）只能在管理页修改。", USER_ERRORS.panelOnlyAccounts[1]],
			"userError.setupComplete": ["部署检查已通过。", USER_ERRORS.setupComplete[1]],
			"userError.modelUnavailable": ["{block} 的模型不可用：{error}", USER_ERRORS.modelUnavailable[1]],
			"userError.promptTooLong": ["提示词配置超过 {limit} 个字符。", USER_ERRORS.promptTooLong[1]],
			"userError.promptPlaceholders": ["「{part}」的模板必须保留占位符 {placeholders}，由系统填入内容。", USER_ERRORS.promptPlaceholders[1]],
			"userError.promptPartEmpty": ["「{part}」段落不能为空；要沿用内置文本，请恢复此段默认内容。", USER_ERRORS.promptPartEmpty[1]],
			"userError.sourceNotInstalled": ["{source} 来源的插件没有安装。", USER_ERRORS.sourceNotInstalled[1]],
			"userError.noLabels": ["这个来源没有可以刷新的名称。", USER_ERRORS.noLabels[1]],
			"userError.nothingToSync": ["{source} 来源上的策略没有指定从哪里同步，或者这个来源已关闭或在等待部署检查。", USER_ERRORS.nothingToSync[1]],
			"setup.repositoryUnset": ["GitHub 来源没有设置监听的仓库。", SETUP_PROBLEMS.repositoryUnset[1]],
			"setup.foreignFile": ["{file} 不是 dsh-superagent 写入的文件；移走它，或换一个状态目录。", SETUP_PROBLEMS.foreignFile[1]],
			"setup.gitTooOld": ["git 没有读取 dsh-superagent 为 github.com 写的凭据配置；需要 git 2.32 或更新版本。", SETUP_PROBLEMS.gitTooOld[1]],
			"setup.environmentFailed": ["准备智能体的运行环境失败。", SETUP_PROBLEMS.environmentFailed[1]],
			"setup.agentCliUnset": ["没有设置智能体的 GitHub CLI。", SETUP_PROBLEMS.agentCliUnset[1]],
			"setup.agentCliMissing": ["找不到智能体的 GitHub CLI。", SETUP_PROBLEMS.agentCliMissing[1]],
			"setup.agentCliSignedOut": ["智能体的 GitHub CLI 读不到它的账号。", SETUP_PROBLEMS.agentCliSignedOut[1]],
			"setup.agentCliNoAccount": ["智能体的 GitHub CLI 没有报告 GitHub 账号。", SETUP_PROBLEMS.agentCliNoAccount[1]],
			"setup.repositoryUnreadable": ["@{account} 读不到 {repository}。", SETUP_PROBLEMS.repositoryUnreadable[1]],
			"setup.repositoryUnreported": ["智能体的 GitHub CLI 没有返回 {repository}。", SETUP_PROBLEMS.repositoryUnreported[1]],
			"setup.repositoryReadOnly": ["@{account} 没有 {repository} 的推送权限。", SETUP_PROBLEMS.repositoryReadOnly[1]],
			"setup.feishuCliFailed": ["机器人的 lark-cli 不可用。", SETUP_PROBLEMS.feishuCliFailed[1]],
			"setup.feishuNoApp": ["机器人的 lark-cli 的 auth status 没有报告应用。", SETUP_PROBLEMS.feishuNoApp[1]],
			"setup.feishuBotNotReady": ["应用 {app} 的机器人身份状态是 {status}；用 lark-cli 配置应用密钥。", SETUP_PROBLEMS.feishuBotNotReady[1]],
			"setup.feishuUserIdentity": ["机器人的 lark-cli 允许用户身份（strict mode 为 {mode}）；按 docs/006-deployment.md 给机器人一份 strict mode 为 bot 的单独配置。", SETUP_PROBLEMS.feishuUserIdentity[1]],
			"setup.feishuNoBot": ["飞书机器人接口没有返回机器人的 open_id。", SETUP_PROBLEMS.feishuNoBot[1]],
			"setup.feishuAppMissing": ["lark-cli 里没有飞书应用 {app} 的 profile，VsSaros Bots 也没有它的 App Secret；先在 Bots 的渠道设置里添加这个应用，或执行 lark-cli profile add --name {app} --app-id {app} --app-secret-stdin。", SETUP_PROBLEMS.feishuAppMissing[1]],
			"setup.feishuProfileFailed": ["lark-cli 没能为飞书应用 {app} 添加只允许机器人身份的 profile：{output}", SETUP_PROBLEMS.feishuProfileFailed[1]],
			"setup.feishuAppMismatch": ["lark-cli 的 profile {profile} 属于应用 {actual}，不是 {app}。", SETUP_PROBLEMS.feishuAppMismatch[1]],
			"healthCode.setupPending": ["等待部署检查", HEALTH_TEXT.setupPending],
			"healthCode.sourceOff": ["已关闭", HEALTH_TEXT.sourceOff],
			"healthCode.feishuCliUnset": ["来源已打开，还没有设置机器人的 lark-cli", HEALTH_TEXT.feishuCliUnset],
			"healthCode.feishuAppShared": ["飞书应用 {app} 已被 {holder} 的 Bots 入站占用；同一应用的事件只会推给其中一条连接，请给这个来源单独配一个飞书应用", HEALTH_TEXT.feishuAppShared],
			"healthCode.feishuBusBusy": ["飞书应用 {app} 已有另一个事件消费者在连接；同一应用的事件只会推给其中一条连接，请停掉它或给这个来源单独配一个飞书应用", HEALTH_TEXT.feishuBusBusy],
			"healthCode.feishuShared": ["通过本机 VsSaros Bots 的长连接接收飞书应用 {app} 的事件", HEALTH_TEXT.feishuShared],
			"healthCode.githubUnset": ["来源已打开，还没有设置仓库和账号 CLI", HEALTH_TEXT.githubUnset],
			"healthCode.tapdUnset": ["来源已打开，还没有设置接收项", HEALTH_TEXT.tapdUnset],
			"healthCode.tapdWebhookUnset": ["TAPD Webhook 已打开，还没有设置验证密码", HEALTH_TEXT.tapdWebhookUnset],
			"healthCode.p4Unset": ["P4 已打开，服务器、执行账号和允许签出的路径还没有都设置", HEALTH_TEXT.p4Unset],
			p4Block: ["P4 变更管理", "P4 change management"],
			p4UnsetHint: ["P4 未配置：签出、改动和提交暂时都用不了，在下面的执行设置里填服务器和执行账号。", "P4 is not set up: no checkouts, changes or submits until its server and execution account are set below."],
			p4BlockHint: ["执行器用这个账号在 P4 里签出、改动并 shelve 改动；提交只在你审核同意之后进行。", "Workers check out, change and shelve in P4 with this account; a submit happens only after you approve it."],
			"healthCode.feishuBotMissing": ["等待飞书机器人", HEALTH_TEXT.feishuBotMissing],
			"healthCode.pollFailures": ["连续 {count} 次轮询失败，最近一次：{error}", HEALTH_TEXT.pollFailures],
			"team.archivedPlans": ["旧团队计划（只读归档）", "Old team plans (archived, read-only)"],
			"team.archivedPlansHint": ["旧的「主管直接派活」双轨已下线：这些计划不会再推进；团队工作只走「工单 → 组队 → 你同意」。", "The old track where the supervisor gave work out on its own is retired: these plans do not advance; team work runs only as a ticket whose team you agree to."],
			"team.skillsArchived": ["旧计划按模板写过 {count} 个技能（只读归档）；技能现在只由记忆系统从团队步骤里提炼。", "Old plans wrote {count} skills by template (archived); skills are now distilled only by the memory system from team steps."],
			"team.approval": ["待你批准建 bot", "Bots waiting for your approval"],
			"team.approvalLine": ["申请高风险工具：{risk}", "Requests high-risk tools: {risk}"],
			"team.approve": ["批准", "Approve"],
			"team.reject": ["驳回", "Reject"],
			"team.created": ["主管已创建 {count} / {global} 个 bot（每计划上限 {perPlan} 个）", "The supervisor created {count} / {global} Bots (at most {perPlan} per plan)"],
			"team.risky": ["含命令 / 外发", "command or outbound"],
			"team.skillApprove": ["审核通过", "Approve skill"],
			"team.skillReject": ["驳回", "Reject"],
			"team.staffing": ["待确认组队", "Teams awaiting agreement"],
			"team.distillPending": ["待确认的技能建议", "Skill suggestions awaiting review"],
			"usageTitle": ["模型用量（24 小时）", "Model usage (24 hours)"],
			"usageHint": ["SuperAgent 自己的会话（主会话、主管台、各工单的 worker、团队步骤）每次模型调用的 token，保留 30 天。输入含缓存读写。", "Tokens of every model call of SuperAgent's own Sessions (main, desk, ticket workers, team steps), kept 30 days. Input includes cache reads and writes."],
			"usageDay": ["24 小时 {total} tokens · {calls} 次调用", "24 hours: {total} tokens · {calls} calls"],
			"usageWeek": ["7 天 {total}", "7 days: {total}"],
			"usageCache": ["其中缓存读 {read}", "cache reads {read}"],
			"usageRelaysDsBot": ["24 小时内 DS Bot 改写重发了 SuperAgent 会话的请求 {resent} 次，另用看图模型读了 {side} 次（都只计一次用量）。", "In 24 hours DS Bot sent SuperAgent's requests again {resent} times and read them with its image model {side} times (each counted once)."],
			"usageRelaysOther": ["24 小时内有其它插件重发了 SuperAgent 会话的请求 {resent} 次，另用别的模型读了 {side} 次（都只计一次用量）。", "In 24 hours another plugin sent SuperAgent's requests again {resent} times and read them with another model {side} times (each counted once)."],
			"usageRelaySession": ["改写 {resent} 次 · 看图 {side} 次", "{resent} rewritten · {side} read on the side"],
			"ticketRelaysDsBot": ["被 DS Bot 改写", "Rewritten by DS Bot"],
			"ticketRelaysOther": ["被其它插件改写", "Rewritten by another plugin"],
			"sideCalls": ["允许其它插件用别的模型读 SuperAgent 会话", "Let other plugins read SuperAgent's Sessions with another model"],
			"sideCallsHint": ["DS Bot 的看图：会话模型不能看图时，它用自己的 OCR 模型读图片。关掉后 SuperAgent 的会话拒绝这类调用，DS Bot 会告诉模型「图片现在读不了」；密钥脱敏的改写重发不受影响。", "DS Bot's images: when a Session's model cannot read images, it reads them with its OCR model. Off, SuperAgent's Sessions refuse such calls and DS Bot tells the model the image could not be read; its secrets rewrite still goes."],
			"sideCallsOff": ["（执行设置里已关闭「别的模型读会话」，这类调用会被拒绝。）", "(Reading with another model is off in the execution settings; such calls are refused.)"],
			"usageCalls": ["{calls} 次", "{calls} calls"],
			"usageRole.master": ["主会话", "Main Session"],
			"usageRole.desk": ["主管台", "Supervisor desk"],
			"usageRole.worker": ["工单 worker / 领队", "Ticket workers / leads"],
			"usageRole.step": ["团队步骤", "Team steps"],
			"usageRole.group": ["群执行", "Group execution"],
			"steward.compacted": ["空闲时已压实（上下文 {context}，检查线 {line}）", "compacted while idle ({context} of context, check line {line})"],
			"steward.below": ["上下文 {context}，未到检查线 {line}", "{context} of context, under the check line {line}"],
			"steward.unknown": ["模型窗口未知，交给 DSH 自己压实", "model window unknown; left to DSH"],
			"steward.cooldown": ["刚压实过，稍后再看", "compacted lately; looked at again later"],
			"steward.busy": ["忙，下次空闲再看", "busy; looked at when next idle"],
			"steward.unavailable": ["DSH 的压实服务不可用", "DSH compaction unavailable"],
			"steward.nothing": ["没有可压实的部分", "nothing to compact"],
			"steward.failed": ["空闲压实失败（见日志）", "idle compaction failed (see the log)"],
			"rulesTitle": ["团队 Bot 的审批规则", "Approval rules of team Bots"],
			"rulesTemplateHint": ["记住的规则让 Bot 同类命令不再问人；带 ; & | 重定向等的组合命令永远要问。选一个 Bot，一次套用一组常用规则：", "A remembered rule lets a Bot run that kind of command without asking; a chained or redirected line always asks. Pick a Bot to give it a set at once:"],
			"rulesBot": ["选择 Bot", "Choose a Bot"],
			"rulesTemplate.git-read": ["Git 只读", "Git read-only"],
			"rulesTemplate.tests": ["跑测试", "Run tests"],
			"rulesTemplate.build": ["构建与检查", "Build and lint"],
			"rulesTemplate.install": ["装依赖", "Install dependencies"],
			"rulesRiskMedium": ["中风险", "medium risk"],
			"rulesForget": ["删除", "Delete"],
			"rulesNone": ["还没有规则", "No rules yet"],
			"coexistDsBot": ["这个 Host 里同时装着 DS Bot。它的大部分功能只管自己的 Bot，但有三处也作用于 SuperAgent 的会话：", "DS Bot runs in this Host too. Most of it acts on its own Bots only; three parts also reach SuperAgent's Sessions:"],
			"coexistEffect.secrets": ["密钥脱敏：在 DS Bot 里存过的密钥值，会从所有工具结果和模型请求里替换掉（改写过的请求会重新发一次，用量只计一次；次数见执行页「用量」与工单详情）", "Secrets: a value saved in DS Bot is replaced in every tool result and model request (a rewritten request is sent again and counted once; how often shows under Usage and on the ticket)"],
			"coexistEffect.images": ["看图：会话的模型不能看图时，DS Bot 用它的 OCR 模型读图片，再把文字发给原模型——步骤里的图片会发给那个模型；可在执行设置里关闭", "Images: when a Session's model cannot read images, DS Bot reads them with its OCR model and sends the text instead, so step images reach that model; you can turn this off in the execution settings"],
			"coexistEffect.skills": ["技能：goal-grill、office、office-tools 进 DSH 的技能目录，主会话与步骤看得到，主管台看不到；不占主会话的 prompt 预算", "Skills: goal-grill, office and office-tools join DSH's skill catalog, seen by the main Session and steps but not the desk; they take nothing from the main Session's prompt budget"],
			"team.budgetLine": ["预算：{tokens} / {tokensCap} tokens · {turns} / {turnsCap} 回合", "Budget: {tokens} / {tokensCap} tokens · {turns} / {turnsCap} turns"],
			"team.budgetReached": ["预算用完：不再开新步骤", "Budget used: no new step starts"],
			"team.budgetRaise": ["追加一半预算", "Raise by half"],
			"team.distillNewVersion": ["已有技能的新版本", "a new version of a skill"],
			"team.distillRisk.low": ["低风险", "Low risk"],
			"team.distillRisk.medium": ["中风险：要跑命令或联网", "Medium risk: runs commands or uses the network"],
			"team.distillRisk.high": ["高风险：外发 / 发布 / 删除 / 凭据", "High risk: sends, publishes, deletes or touches credentials"],
			"team.distillTemplate": ["未经模型提炼", "Not distilled by a model"],
			"team.steps": ["团队步骤进度", "Team steps"],
			"team.stepsDone": ["{done}/{total} 完成", "{done}/{total} done"],
			"team.stepWrite": ["（写）", " (writes)"],
			"team.stepTurns": [" · {turns} 回合", " · {turns} turns"],
			"team.stepAttempt": [" · 第 {attempt} 次", " · attempt {attempt}"],
			"team.step.pending": ["等待", "Waiting"],
			"team.step.running": ["进行中", "Running"],
			"team.step.ready": ["完成", "Done"],
			"team.step.blocked": ["待人回答", "Needs a person"],
			"team.step.failed": ["失败", "Failed"],
			"team.step.skipped": ["已跳过", "Skipped"],
			"team.step.stopped": ["已停止", "Stopped"],
			"team.staffingProposing": ["主管正在组队", "The supervisor is staffing"],
			"team.staffingNew": ["（新建）", " (new)"],
			"team.staffingAgree": ["同意并开工", "Agree and start"],
			"team.staffingRefuse": ["取消工单", "Drop the ticket"],
			"team.staffingRefuseTitle": ["取消这张工单？", "Drop this ticket?"],
			"team.staffingRefuseConfirm": ["「{title}」不再执行，工单以放弃结束；之后线程里的消息不会让它恢复。", "\"{title}\" will not run: the ticket ends as dropped, and later messages on its threads do not resume it."],
			"team.running": ["进行中 · {running} / 3 个步骤", "{running} / 3 steps running"],
			"team.state.running": ["进行中", "Running"],
			"team.state.done": ["已完成", "Done"],
			"team.state.failed": ["失败", "Failed"],
			"team.state.cancelled": ["已停止", "Stopped"],
			"team.state.pending": ["等待", "Waiting"],
			"team.state.skipped": ["已跳过", "Skipped"],
			"team.step": ["{step} {title} · {bot}", "{step} {title} · {bot}"],
			"team.after": ["等待 {after}", "after {after}"],
			"review.pending": ["待你审核的提交", "Changelists waiting for your review"],
			"review.section": ["提交审核 · CL {change}", "Review · CL {change}"],
			"review.open": ["审核", "Review"],
			"review.waitingLine": ["CL {change} · {files} 个文件 · {time}提请", "CL {change} · {files} file(s) · asked {time}"],
			"review.workspace": ["工作区", "Workspace"],
			"review.fingerprint": ["内容指纹", "Content fingerprint"],
			"review.description": ["CL 描述", "CL description"],
			"review.files": ["文件", "Files"],
			"review.filesHint": ["逐个展开看过所有文件后，才能同意。审核期间执行器收不到新消息，不会改动这份 shelve。", "Open every file before approving. While you review, the Executor gets no new messages and does not change this shelf."],
			"review.binary": ["二进制或没有文本差异", "Binary, or no text difference"],
			"review.truncated": ["差异过长，只显示前一部分", "The difference is long; only its start is shown"],
			"review.seen": ["已看 {seen} / {total}", "Seen {seen} / {total}"],
			"review.ack": ["我已 review 全部文件，同意提交这份内容", "I reviewed every file and approve submitting this content"],
			"review.approve": ["同意并提交", "Approve and submit"],
			"review.approveTitle": ["同意提交 CL {change}", "Approve CL {change}"],
			"review.approvePipeline": ["同意后，CL 描述会加上 {tags}，由服务器的提交流水线提交。提交前会再核对一次内容指纹。", "Once approved, {tags} is added to the CL description and the server's submit automation submits it. The fingerprint is checked again first."],
			"review.approveHost": ["同意后，dsh-superagent 会以提交账号提交这份 shelve。提交前会再核对一次内容指纹。", "Once approved, dsh-superagent submits this shelf as the submit account. The fingerprint is checked again first."],
			"review.reject": ["打回", "Send back"],
			"review.rejectTitle": ["打回 CL {change}", "Send back CL {change}"],
			"review.rejectHint": ["写下要执行器改什么；它改完重新 shelve 后会再请你审核。", "Say what the Executor should change; it asks again once it shelves anew."],
			"review.rejectPlaceholder": ["例如：测试用例补一个 1x 缩放", "For example: add a test at 1x scale"],
			"review.discard": ["放弃这次变更", "Discard the change"],
			"review.discardTitle": ["放弃 CL {change}", "Discard CL {change}"],
			"review.discardConfirm": ["删除 shelve、撤销签出的文件并删除这个 CL，然后停止工单。不能撤回。", "Deletes the shelf, reverts the opened files and deletes the CL, then stops the ticket. This cannot be undone."],
			"review.changed": ["这些文件在你审核后变了：", "These files changed after you reviewed them:"],
			"review.state.handed": ["已同意，已交给提交流水线 · {by}", "Approved and handed to the submit automation · {by}"],
			"review.state.submitted": ["已同意并提交为 CL {submitted} · {by}", "Approved and submitted as CL {submitted} · {by}"],
			"review.state.rejected": ["已打回 · {by}：{comment}", "Sent back · {by}: {comment}"],
			"review.state.discarded": ["已放弃 · {by}", "Discarded · {by}"],
			"review.state.submitting": ["正在提交…", "Submitting…"],
			"review.lastError": ["上次提交失败，同意未被使用：{error}", "The last submit failed and the approval was not used: {error}"],
			"cliCheck.local": ["自动本地检查", "Check locally"],
			"cliCheck.update": ["检查版本/更新", "Check version / updates"],
			"cliCheck.path": ["可执行文件", "Executable"],
			"cliCheck.version": ["版本", "Version"],
			"cliCheck.bot": ["机器人身份", "Bot identity"],
			"cliCheck.strict": ["严格模式", "Strict mode"],
			"cliCheck.botName": ["机器人名称", "Bot name"],
			"cliCheck.latest": ["可用更新", "Available update"],
			"cliCheck.notFound": ["未找到 lark-cli", "lark-cli not found"],
			"cliCheck.applied": ["已完成，正在重新检查…", "Done; checking again…"],
			"cliCheck.applyStrict": ["应用 strict-mode bot", "Apply strict-mode bot"],
			"cliCheck.applyStrictTitle": ["把 lark-cli 限制为机器人身份", "Restrict lark-cli to the bot identity"],
			"cliCheck.applyStrictConfirm": ["这会修改本机 lark-cli 的全局配置，也会影响其它使用它的功能；SuperAgent 要求 strict-mode 为 bot 才会接收消息。确定继续？", "This changes the machine-wide lark-cli configuration and affects everything else using it. SuperAgent requires strict-mode bot before it receives messages. Continue?"],
			"cliCheck.runUpdate": ["运行 lark-cli update", "Run lark-cli update"],
			"cliCheck.runUpdateTitle": ["更新 lark-cli", "Update lark-cli"],
			"cliCheck.runUpdateConfirm": ["这会在本机执行 lark-cli update，可能全局升级 npm 包并需要较长时间。确定继续？", "This runs lark-cli update on this machine, which may upgrade the global npm package and take a while. Continue?"],
			"tapdCred.title": ["Open API 凭据", "Open API credentials"],
			"tapdCred.status": ["状态", "Status"],
			"tapdCred.fromEnv": ["已配置 · Host 环境变量", "Set · Host environment"],
			"tapdCred.fromFile": ["已配置 · 凭据文件", "Set · credentials file"],
			"tapdCred.fromBundled": ["已配置 · 随包接入应用", "Set · shipped app"],
			"tapdCred.bundledHint": ["安装包自带 TAPD 接入应用，装完即可读取 TAPD；在这里保存自己的凭据、写入凭据文件或设置 Host 环境变量，都会优先使用你配的那份。随包密钥是明文编译在 lib/ 里的产品凭据，轮换需要升级版本；自己的敏感账号请放在本机凭据文件里，不要写回仓库。", "This installation ships a TAPD API account, so TAPD works out of the box. A credential saved here, in the credentials file or in the Host environment takes precedence. The shipped secret is plain text compiled into lib/: rotating it needs a product update, so keep your own sensitive account in the local credentials file, never in the repository."],
			"tapdCred.none": ["未配置", "Not set"],
			"tapdCred.method": ["使用的凭据", "Credential in use"],
			"tapdCred.methodBundled": ["Basic 随包接入应用（API account，内置于安装包）", "Basic shipped app (API account, built into the installation)"],
			"tapdCred.account": ["账号", "Account"],
			"tapdCred.file": ["凭据文件", "Credentials file"],
			"tapdCred.overridden": ["Host 的环境变量里有优先级更高的 TAPD 凭据，正在用它而不是这里保存的；要改用这里的，请先去掉那些环境变量并重启 IDE。", "The Host environment carries a higher-priority TAPD credential, which is used instead of the one saved here; to use this one, remove those variables and restart the IDE."],
			"tapdCred.kind": ["凭据类型", "Credential kind"],
			"tapdCred.kind.client": ["企业 API 账号（推荐）", "API account (recommended)"],
			"tapdCred.kind.user": ["API 用户名 / 密码", "API user / password"],
			"tapdCred.kind.token": ["Token", "Token"],
			"tapdCred.clientId": ["Client ID", "Client ID"],
			"tapdCred.clientSecret": ["Client Secret", "Client Secret"],
			"tapdCred.user": ["API 用户名", "API user"],
			"tapdCred.password": ["API 密码", "API password"],
			"tapdCred.token": ["Token", "Token"],
			"tapdCred.keep": ["留空 = 保留 {value}", "Blank keeps {value}"],
			"tapdCred.keepSecret": ["已配置 · 留空 = 不改", "Set · blank keeps it"],
			"tapdCred.hint": ["保存到 Host 的凭据文件（仅本用户可读），不进设置、不回传明文，执行器读不到；即存即用，不用重启。保存会替换文件里全部 8 个凭据键（超时、项目等非凭据行保留），其它高优先级凭据会被清掉。", "Saved to the Host's credentials file (readable by you only), never to the settings and never sent back; Executors cannot read it. It works at once, without a restart. Saving replaces all 8 credential keys in the file (timeouts and workspace stay), so other higher-priority keys are removed."],
			"tapdCred.custom": ["自定义凭据（可选）", "Custom credentials (optional)"],
			"tapdCred.customHint": ["安装包已内置 TAPD 接入应用，正常情况无需在这里填写。只有要用自己的企业 API 账号 / API 用户名 / Token 覆盖内置账号时才展开；也可以直接用凭据文件或 Host 环境变量覆盖。", "A TAPD API account is built into the installation, so nothing needs to be entered here. Expand only to override it with your own enterprise API account, API user or Token; a credentials file or Host environment variables work too."],
			"tapdCred.details": ["凭据优先级与轮换", "Credential priority and rotation"],
			"tapdCred.detailsHint": ["只认 TAPD Open API，按优先级：① DSH_SUPERAGENT_TAPD_BEARER；② DSH_SUPERAGENT_TAPD_USER + DSH_SUPERAGENT_TAPD_PASSWORD；③ TAPD_CLIENT_ID + TAPD_CLIENT_SECRET（推荐企业 API 账号）；④ TAPD_API_USER + TAPD_API_PWD；⑤ TAPD_API_TOKEN；以上都没有时用随包账号。可放 Host 环境变量（需重启 IDE 继承），或写成 KEY=VALUE 放在 <DSH_HOME>/tapd.env / DSH_SUPERAGENT_TAPD_ENV_FILE 指向的文件（即用即读、只读白名单键、不覆盖环境变量）。轮换：面板保存新凭据，或停用随包账号后改文件；Webhook 验证密码另在高级区，与本凭据无关。", "Only TAPD Open API is used, in priority order: (1) DSH_SUPERAGENT_TAPD_BEARER; (2) DSH_SUPERAGENT_TAPD_USER + DSH_SUPERAGENT_TAPD_PASSWORD; (3) TAPD_CLIENT_ID + TAPD_CLIENT_SECRET (recommended enterprise account); (4) TAPD_API_USER + TAPD_API_PWD; (5) TAPD_API_TOKEN; otherwise the shipped account. Put them in the Host environment (restart the IDE to inherit) or as KEY=VALUE in <DSH_HOME>/tapd.env or the file DSH_SUPERAGENT_TAPD_ENV_FILE names (read on demand, whitelisted keys only, never overriding the environment). To rotate: save a new credential here, or disable the shipped account and edit the file. The Webhook secret is separate, under Advanced."],
			"tapdCred.save": ["保存凭据", "Save credentials"],
			"tapdCred.saving": ["保存中…", "Saving…"],
			"tapdCred.saved": ["TAPD 凭据已保存", "TAPD credentials saved"],
			"tapdCred.clear": ["清除凭据", "Clear credentials"],
			"tapdCred.clearTitle": ["清除 TAPD 凭据", "Clear the TAPD credentials"],
			"tapdCred.clearConfirm": ["从 {file} 删除你保存的 TAPD 凭据（其它行保留）。之后会回落到安装包自带的接入应用；若要完全停用，用下面的「停用随包账号」。确定继续？", "This removes your saved TAPD credentials from {file} (other lines stay). The API account shipped with the installation takes over; use \"Disable shipped account\" below to turn it off entirely. Continue?"],
			"tapdCred.cleared": ["TAPD 凭据已清除", "TAPD credentials cleared"],
			"tapdCred.writeTo": ["自定义凭据写入", "Custom credentials file"],
			"tapdCred.overrideHint": ["当前用的是随包账号。要改成自己的，Client ID 与 Client Secret 都要填（不会沿用随包密钥，也不会把它写进凭据文件）。", "The shipped account is in use. To replace it, enter both Client ID and Client Secret; the shipped secret is never reused or written to the credentials file."],
			"tapdCred.bundledOff": ["停用随包账号", "Disable shipped account"],
			"tapdCred.bundledOffTitle": ["停用随包 TAPD 接入应用", "Disable the shipped TAPD account"],
			"tapdCred.bundledOffConfirm": ["会在凭据文件里写入 DSH_SUPERAGENT_TAPD_BUNDLED=off，立即生效、不用重启。若没有配置其它凭据，TAPD 将无法读取，直到重新启用或填入自己的凭据。确定继续？", "This writes DSH_SUPERAGENT_TAPD_BUNDLED=off to the credentials file and takes effect at once, with no restart. Without another credential TAPD cannot be read until you enable it again or enter your own. Continue?"],
			"tapdCred.bundledOn": ["启用随包账号", "Enable shipped account"],
			"tapdCred.bundledSwitched": ["随包接入应用设置已更新", "Shipped account setting updated"],
			"tapdCheck.title": ["接入检查", "Setup checklist"],
			"tapdCheck.credentials": ["凭据", "Credentials"],
			"tapdCheck.watches": ["接收项", "Watches"],
			"tapdCheck.watchesNone": ["未添加 · 来源不会接收任何单", "None · the Source receives nothing"],
			"tapdCheck.watchesSome": ["已添加 {count} 项", "{count} configured"],
			"tapdCheck.draftSaved": ["草稿 {count} 项（保存后生效）", "draft: {count} (save to apply)"],
			"tapdCheck.watchesAdd": ["添加推荐接收项", "Add recommended watches"],
			"tapdCheck.watchesAdded": ["已加入两个推荐接收项，记得保存来源设置", "Added two starter watches; save the Source card to apply"],
			"tapdCheck.identity": ["TAPD 身份名", "TAPD identity"],
			"tapdCheck.identityEmpty": ["未填 · 接收项需设为「全部变化」", "Empty · set watches to \"All changes\""],
			"tapdCheck.identityMapped": ["已解析为 {name}", "Resolved to {name}"],
			"tapdCheck.identityUnmapped": ["按「{name}」原文匹配；TAPD 用中文名时请到高级加映射", "Matching \"{name}\" literally; add a mapping under Advanced if TAPD uses Chinese names"],
			"tapdCheck.health": ["来源状态", "Source health"],
			"tapdCheck.healthUnknown": ["尚未上报", "Not reported yet"],
			"tapdCheck.connectivity": ["连通性", "Connectivity"],
			"tapdCheck.notTested": ["未测试", "Not tested"],
			"tapdCheck.test": ["测试连接", "Test connection"],
			"tapdCheck.testing": ["测试中…", "Testing…"],
			"tapdCheck.testOk": ["通过 · {method}", "OK · {method}"],
			"tapdCheck.testFail": ["失败 · {error}", "Failed · {error}"]
		};
		const language = (index) => Object.fromEntries(Object.entries(TEXT).map(([key, pair]) => [key, pair[index]]));
		const zh = language(0);
		const en = language(1);
		/** Glossary terms grouped by stage flow after the acting roles; each key maps to `term.<key>` and `meaning.<key>`. */
		const GLOSSARY = {
			roles: [
				"agent",
				"mainSession",
				"executorSession"
			],
			source: ["source", "channel"],
			trigger: [
				"trigger",
				"thread",
				"correlation",
				"subscription",
				"fanout",
				"disposition"
			],
			eval: [
				"policy",
				"policyVersion",
				"eval",
				"gate",
				"assessment",
				"decision",
				"mandate",
				"scope",
				"strength"
			],
			execution: [
				"executor",
				"environment",
				"ticket",
				"assignment",
				"input",
				"report",
				"attention"
			]
		};
		const GLOSSARY_VALUES = {
			decision: [
				"decision.accept",
				"decision.reopen",
				"decision.stop",
				"decision.ignore",
				"decision.unavailable"
			],
			strength: ["strength.explicit", "strength.inferred"],
			ticket: [
				"stage.staffing",
				"stage.answer",
				"stage.review",
				"stage.blocked",
				"stage.failed",
				"stage.delivery",
				"stage.queued",
				"stage.working",
				"stage.idle",
				"ticket.ended"
			],
			assignment: [
				"assignment.pending",
				"assignment.running",
				"assignment.ended"
			],
			report: [
				"report.progress",
				"report.waiting",
				"report.ready",
				"report.blocked",
				"report.failed",
				"report.dropped"
			]
		};
		const line = (paths) => function LineIcon() {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("svg", {
				width: 16,
				height: 16,
				viewBox: "0 0 20 20",
				fill: "none",
				stroke: "currentColor",
				strokeWidth: 1.6,
				strokeLinecap: "round",
				strokeLinejoin: "round",
				"aria-hidden": "true",
				children: paths.map((d) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d }, d))
			});
		};
		const PlusIcon = () => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("svg", {
			width: 14,
			height: 14,
			viewBox: "0 0 20 20",
			"aria-hidden": "true",
			children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
				d: "M10 3.5v13M3.5 10h13",
				stroke: "currentColor",
				strokeWidth: 1.6,
				strokeLinecap: "round"
			})
		});
		const PaperclipIcon = line(["M15.5 9.5l-5.6 5.6a3.4 3.4 0 0 1-4.8-4.8l6.1-6.1a2.25 2.25 0 0 1 3.2 3.2l-6 6a1.1 1.1 0 0 1-1.6-1.6l5.5-5.5"]);
		const ChatsIcon = line(["M3.5 5.5A1.5 1.5 0 0 1 5 4h7a1.5 1.5 0 0 1 1.5 1.5V10A1.5 1.5 0 0 1 12 11.5H8L5 14v-2.5A1.5 1.5 0 0 1 3.5 10z", "M13.5 7.5H15A1.5 1.5 0 0 1 16.5 9v4.5A1.5 1.5 0 0 1 15 15v2l-2.5-2h-3A1.5 1.5 0 0 1 8 13.5V13"]);
		const ClockIcon = line(["M10 3.5a6.5 6.5 0 1 1 0 13 6.5 6.5 0 0 1 0-13z", "M10 6.5V10l2.5 1.5"]);
		const BackIcon = line(["M12 5l-5 5 5 5"]);
		const CloseIcon = line(["M5.5 5.5l9 9M14.5 5.5l-9 9"]);
		const MicIcon = () => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("svg", {
			width: 16,
			height: 16,
			viewBox: "0 0 20 20",
			fill: "none",
			stroke: "currentColor",
			strokeWidth: 1.6,
			strokeLinecap: "round",
			"aria-hidden": "true",
			children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("rect", {
				x: 7,
				y: 2.5,
				width: 6,
				height: 10,
				rx: 3,
				fill: "currentColor",
				stroke: "none"
			}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M4.5 9.5a5.5 5.5 0 0 0 11 0M10 15v2.5" })]
		});
		const WaveIcon = ({ size = 16 }) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("svg", {
			width: size,
			height: size,
			viewBox: "0 0 20 20",
			fill: "currentColor",
			"aria-hidden": "true",
			children: [
				[
					3,
					7.5,
					5
				],
				[
					6.5,
					4.5,
					11
				],
				[
					10,
					2.5,
					15
				],
				[
					13.5,
					5.5,
					9
				],
				[
					17,
					8,
					4
				]
			].map(([x, y, height]) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("rect", {
				x: x - 1,
				y,
				width: 2,
				height,
				rx: 1
			}, x))
		});
		const SendIcon = () => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("svg", {
			width: 14,
			height: 14,
			viewBox: "0 0 20 20",
			fill: "none",
			stroke: "currentColor",
			strokeWidth: 2,
			strokeLinecap: "round",
			strokeLinejoin: "round",
			"aria-hidden": "true",
			children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M10 16V4M5 9l5-5 5 5" })
		});
		/** Keeps the draft focused when a composer button is pressed. */
		const keepFocus = (event) => event.preventDefault();
		const speechApi = () => {
			const scope = window;
			return scope.SpeechRecognition ?? scope.webkitSpeechRecognition;
		};
		/** The note for a recognition error, or none for one that only means nothing was said. */
		function speechNote(error) {
			if (error === "aborted" || error === "no-speech") return void 0;
			if (error === "not-allowed" || error === "service-not-allowed" || error === "audio-capture") return "composer.micBlocked";
			if (error === "network") return "composer.dictationOffline";
			return "composer.notHeard";
		}
		/** Dictation into the draft: `onText` gets interim text (`final` false) and each final phrase. */
		function useDictation(onText) {
			const { t } = usePanel();
			const [listening, setListening] = (0, react.useState)(false);
			const [note, setNote] = (0, react.useState)("");
			const engine = (0, react.useRef)(void 0);
			const latest = (0, react.useRef)(onText);
			latest.current = onText;
			(0, react.useEffect)(() => () => engine.current?.abort(), []);
			(0, react.useEffect)(() => {
				if (!note) return void 0;
				const timer = setTimeout(() => setNote(""), 2600);
				return () => clearTimeout(timer);
			}, [note]);
			const start = (options = {}) => {
				const Api = speechApi();
				if (!Api) {
					setNote(t("composer.dictationUnavailable"));
					return false;
				}
				const recognition = new Api();
				let heard = false;
				recognition.lang = navigator.language || "zh-CN";
				recognition.interimResults = true;
				recognition.continuous = options.continuous ?? true;
				recognition.onresult = (event) => {
					let interim = "";
					for (let index = event.resultIndex; index < event.results.length; index += 1) {
						const result = event.results[index];
						const text = result[0]?.transcript ?? "";
						if (result.isFinal) {
							if (text.trim()) {
								heard = true;
								latest.current(text, true);
							}
						} else interim += text;
					}
					if (interim) latest.current(interim, false);
				};
				recognition.onerror = (event) => {
					const key = speechNote(event.error);
					if (!key) return;
					setNote(t(key));
					options.onError?.(t(key));
				};
				recognition.onend = () => {
					setListening(false);
					engine.current = void 0;
					options.onEnd?.(heard);
				};
				engine.current = recognition;
				try {
					recognition.start();
					setListening(true);
					return true;
				} catch {
					setNote(t("composer.notHeard"));
					return false;
				}
			};
			const stop = () => engine.current?.stop();
			const abort = () => {
				if (engine.current) {
					engine.current.onend = null;
					engine.current.abort();
					engine.current = void 0;
					setListening(false);
				}
			};
			return {
				listening,
				note,
				start,
				stop,
				abort
			};
		}
		/** A file as base64, for `POST desk/files`. */
		function readBase64(file) {
			return new Promise((resolve, reject) => {
				const reader = new FileReader();
				reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ""));
				reader.onerror = () => reject(reader.error ?? /* @__PURE__ */ new Error("The file could not be read"));
				reader.readAsDataURL(file);
			});
		}
		const sizeLabel = (bytes) => bytes < 1024 ? `${bytes} B` : bytes < 1048576 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
		/** The composer: the draft and its attachments, and the "+" menu. `send` gets the whole message, attachments named in it. */
		function DeskComposer({ send, busy, onVoice, queued = 0 }) {
			const { t, call, notify } = usePanel();
			const [draft, setDraft] = (0, react.useState)("");
			const [files, setFiles] = (0, react.useState)([]);
			const [menu, setMenu] = (0, react.useState)();
			const [scheduling, setScheduling] = (0, react.useState)(false);
			const [uploading, setUploading] = (0, react.useState)(false);
			const input = (0, react.useRef)(null);
			const picker = (0, react.useRef)(null);
			const card = (0, react.useRef)(null);
			const insert = (text) => {
				const box = input.current;
				const start = box?.selectionStart ?? draft.length, end = box?.selectionEnd ?? draft.length;
				const next = draft.slice(0, start) + text + draft.slice(end);
				setDraft(next);
				setTimeout(() => {
					box?.focus();
					box?.setSelectionRange(start + text.length, start + text.length);
				}, 0);
			};
			const dictation = useDictation((text, final) => {
				if (final) insert(text);
			});
			(0, react.useEffect)(() => {
				if (!menu) return void 0;
				const down = (event) => {
					if (!card.current?.contains(event.target)) setMenu(void 0);
				};
				const key = (event) => {
					if (event.key === "Escape") {
						event.stopPropagation();
						setMenu(void 0);
					}
				};
				window.addEventListener("mousedown", down, true);
				window.addEventListener("keydown", key, true);
				return () => {
					window.removeEventListener("mousedown", down, true);
					window.removeEventListener("keydown", key, true);
				};
			}, [menu]);
			const addFiles = (picked) => {
				const fits = [...picked ?? []].filter((file) => {
					if (file.size <= 10485760) return true;
					notify(t("composer.fileTooBig", { name: file.name }));
					return false;
				});
				const next = [...files, ...fits];
				if (next.length > 5) notify(t("composer.tooManyFiles", { count: String(5) }));
				setFiles(next.slice(0, 5));
				if (picker.current) picker.current.value = "";
				input.current?.focus();
			};
			const empty = !draft.trim() && !files.length;
			const submit = async () => {
				const body = draft.trim();
				const captured = files;
				if (!body && !captured.length) return;
				setDraft("");
				setFiles([]);
				const restore = () => {
					setDraft((previous) => previous.trim() ? previous : body);
					setFiles((previous) => previous.length ? previous : captured);
				};
				let text = body;
				if (captured.length) {
					setUploading(true);
					try {
						const kept = [];
						for (const file of captured) kept.push(await call("POST desk/files", { body: {
							name: file.name,
							data: await readBase64(file)
						} }));
						text = [body, `${t("composer.attachmentsHeader")}\n${kept.map((file) => `- ${file.name}（${sizeLabel(file.size)}）：${file.path}`).join("\n")}`].filter(Boolean).join("\n\n");
					} catch (failure) {
						notify(errorText(failure));
						restore();
						return;
					} finally {
						setUploading(false);
					}
				}
				if (!await send(text)) restore();
			};
			const keys = (event) => {
				const composing = event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229 || event.nativeEvent.getModifierState?.("AltGraph");
				if (event.key !== "Enter" || event.shiftKey || composing) return;
				event.preventDefault();
				submit();
			};
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "dt-composer-dock",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					ref: card,
					className: "dt-composer",
					"data-tall": files.length > 0 || draft.includes("\n") || void 0,
					children: [
						menu && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: "dt-menu",
							role: "menu",
							"aria-label": t("composer.add"),
							children: menu === "root" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
									type: "button",
									role: "menuitem",
									onClick: () => {
										setMenu(void 0);
										picker.current?.click();
									},
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(PaperclipIcon, {}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("composer.addFiles") })]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
									type: "button",
									role: "menuitem",
									onMouseDown: keepFocus,
									onClick: () => setMenu("reference"),
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(ChatsIcon, {}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("composer.reference") })]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
									type: "button",
									role: "menuitem",
									onClick: () => {
										setMenu(void 0);
										setScheduling(true);
									},
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(ClockIcon, {}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("composer.schedule") })]
								})
							] }) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ReferenceList, {
								onBack: () => setMenu("root"),
								onPick: (title, key) => {
									setMenu(void 0);
									insert(t("composer.referenceText", {
										title,
										key
									}));
								}
							})
						}),
						files.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: "dt-composer-files",
							children: files.map((file, index) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								className: "dt-composer-file",
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)(PaperclipIcon, {}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: "dt-composer-file-name",
										children: file.name
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: "dt-composer-file-size",
										children: sizeLabel(file.size)
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										"aria-label": t("composer.removeFile", { name: file.name }),
										title: t("composer.removeFile", { name: file.name }),
										onClick: () => setFiles(files.filter((_, at) => at !== index)),
										children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(CloseIcon, {})
									})
								]
							}, `${file.name}-${index}`))
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: "dt-composer-plus",
							"aria-label": t("composer.add"),
							title: t("composer.add"),
							"aria-haspopup": "menu",
							"aria-expanded": !!menu,
							onMouseDown: keepFocus,
							onClick: () => setMenu(menu ? void 0 : "root"),
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(PlusIcon, {})
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
							ref: picker,
							type: "file",
							multiple: true,
							hidden: true,
							"aria-hidden": "true",
							tabIndex: -1,
							onChange: (event) => addFiles(event.target.files)
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("textarea", {
							ref: input,
							className: "dt-composer-input",
							rows: 1,
							value: draft,
							"aria-label": t("chat.label"),
							placeholder: t("chat.placeholder"),
							"aria-busy": busy || uploading || void 0,
							onChange: (event) => setDraft(event.target.value),
							onKeyDown: keys
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "dt-composer-trailing",
							children: [empty ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: "dt-composer-voice",
								"aria-label": t("composer.voiceStart"),
								title: t("composer.voiceTitle"),
								onMouseDown: keepFocus,
								onClick: onVoice,
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(WaveIcon, { size: 18 })
							}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: "dt-composer-send",
								"aria-label": t("chat.send"),
								title: t("chat.send"),
								"aria-busy": busy || uploading || void 0,
								onMouseDown: keepFocus,
								onClick: () => {
									submit();
								},
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(SendIcon, {})
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: "dt-composer-mic",
								"aria-pressed": dictation.listening,
								"aria-label": t(dictation.listening ? "composer.stopDictation" : "composer.dictate"),
								title: t(dictation.listening ? "composer.stopDictation" : "composer.dictate"),
								onMouseDown: keepFocus,
								onClick: () => {
									if (dictation.listening) dictation.stop();
									else dictation.start();
								},
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(MicIcon, {})
							})]
						}),
						(dictation.note || uploading || queued > 0) && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "dt-composer-note",
							"data-testid": "composer-queue-note",
							role: "status",
							children: uploading ? t("composer.uploading") : dictation.note || t("composer.queued", { n: String(queued) })
						})
					]
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ScheduleDialog, {
					open: scheduling,
					draft,
					onClose: () => setScheduling(false),
					onScheduled: (used) => {
						if (used) setDraft("");
					}
				})]
			});
		}
		/** The chats a message may reference: the Threads of dsh-superagent, newest first, without the desk itself. */
		function ReferenceList({ onBack, onPick }) {
			const { t, call } = usePanel();
			const [threads, setThreads] = (0, react.useState)();
			const [failure, setFailure] = (0, react.useState)("");
			(0, react.useEffect)(() => {
				let live = true;
				call("GET threads", { query: {
					filter: "all",
					limit: 20
				} }).then((list) => {
					if (live) setThreads(list.items.filter((item) => !item.key.startsWith("superagent:desk:")));
				}, (error) => {
					if (live) setFailure(errorText(error));
				});
				return () => {
					live = false;
				};
			}, [call]);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
				type: "button",
				className: "dt-menu-head",
				onMouseDown: keepFocus,
				onClick: onBack,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(BackIcon, {}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("composer.referenceTitle") })]
			}), failure ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
				className: "dt-menu-note",
				children: failure
			}) : !threads ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
				className: "dt-menu-note",
				children: t("loading")
			}) : !threads.length ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
				className: "dt-menu-note",
				children: t("composer.referenceEmpty")
			}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: "dt-menu-list",
				children: threads.map((item) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
					type: "button",
					role: "menuitem",
					onMouseDown: keepFocus,
					onClick: () => onPick(item.title, item.key),
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(ChatsIcon, {}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "dt-menu-label",
							children: item.title
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "dt-menu-hint",
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(When, { at: item.lastAt })
						})
					]
				}, item.key))
			})] });
		}
		/** The next whole hour, as a `datetime-local` value. */
		function nextHourLocal(now = /* @__PURE__ */ new Date()) {
			const next = new Date(now);
			next.setMinutes(0, 0, 0);
			next.setHours(next.getHours() + 1);
			const pad = (value) => String(value).padStart(2, "0");
			return `${next.getFullYear()}-${pad(next.getMonth() + 1)}-${pad(next.getDate())}T${pad(next.getHours())}:${pad(next.getMinutes())}`;
		}
		/** Schedules a message to the supervisor, and lists and removes the ones scheduled before. */
		function ScheduleDialog({ open, draft, onClose, onScheduled }) {
			const { t, call, notify } = usePanel();
			const [text, setText] = (0, react.useState)("");
			const [at, setAt] = (0, react.useState)("");
			const [repeat, setRepeat] = (0, react.useState)("none");
			const [list, setList] = (0, react.useState)();
			const [busy, setBusy] = (0, react.useState)(false);
			const load = () => call("GET desk/schedules").then((value) => setList(value.schedules), (failure) => notify(errorText(failure)));
			(0, react.useEffect)(() => {
				if (!open) return;
				setText(draft.trim());
				setAt(nextHourLocal());
				setRepeat("none");
				load();
			}, [open]);
			const save = async () => {
				if (!text.trim() || !at || busy) return;
				setBusy(true);
				try {
					const saved = await call("POST desk/schedules", { body: {
						text: text.trim(),
						at: new Date(at).toISOString(),
						repeat
					} });
					notify(t("schedule.saved", { when: fullTime(saved.at, t("lang")) }));
					onScheduled(!!draft.trim() && text.trim() === draft.trim());
					onClose();
				} catch (failure) {
					notify(errorText(failure));
				} finally {
					setBusy(false);
				}
			};
			const remove = async (id) => {
				try {
					await call("POST desk/schedules/:id/delete", { id });
					await load();
				} catch (failure) {
					notify(errorText(failure));
				}
			};
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Modal, {
				open,
				onClose,
				title: t("schedule.title"),
				closeLabel: t("schedule.close"),
				description: t("schedule.description"),
				footer: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Button, {
					variant: "ghost",
					onClick: onClose,
					children: t("schedule.close")
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Button, {
					variant: "primary",
					disabled: busy || !text.trim() || !at,
					onClick: () => {
						save();
					},
					children: t("schedule.save")
				})] }),
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "dt-form dt-schedule",
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
							className: "dt-field",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("schedule.text") }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("textarea", {
								className: "dt-textarea",
								rows: 3,
								value: text,
								onChange: (event) => setText(event.target.value)
							})]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "dt-schedule-when",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
								className: "dt-field",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("schedule.at") }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
									className: "dt-select",
									type: "datetime-local",
									value: at,
									onChange: (event) => setAt(event.target.value)
								})]
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
								className: "dt-field",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("schedule.repeat") }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("select", {
									className: "dt-select",
									value: repeat,
									onChange: (event) => setRepeat(event.target.value),
									children: [
										"none",
										"daily",
										"weekdays"
									].map((value) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
										value,
										children: t(`schedule.${value}`)
									}, value))
								})]
							})]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "dt-field",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("schedule.list") }), !list?.length ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								className: "dt-hint",
								children: t("schedule.empty")
							}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("ul", {
								className: "dt-list",
								"data-testid": "desk-schedules",
								children: list.map((item) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", {
									className: "dt-row",
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: "dt-row-main",
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
											className: "dt-row-title",
											children: item.text
										}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
											className: "dt-row-meta",
											children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: fullTime(item.at, t("lang")) }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t(`schedule.${item.repeat}`) })]
										})]
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
										className: "dt-row-actions",
										children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Button, {
											variant: "outline",
											size: "sm",
											onClick: () => {
												remove(item.id);
											},
											children: t("schedule.delete")
										})
									})]
								}, item.id))
							})]
						})
					]
				})
			});
		}
		/** Markdown and headers read aloud as plain words. */
		const plainSpeech = (text) => text.replace(/```[\s\S]*?```/g, " ").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[*_`#>|~]+/g, " ").replace(/\s+/g, " ").trim();
		/**
		* Voice chat with SuperAgent: listens, sends what the person said, reads the answer aloud, and listens again, until the
		* person pauses or ends it. An answer that takes long is left to the conversation, and listening goes on.
		*/
		function VoicePane({ messages, send, onClose }) {
			const { t } = usePanel();
			const [phase, setPhaseState] = (0, react.useState)(speechApi() ? "listening" : "unsupported");
			const [caption, setCaption] = (0, react.useState)("");
			const [note, setNote] = (0, react.useState)(speechApi() ? "" : t("voice.unsupported"));
			const heardText = (0, react.useRef)("");
			const known = (0, react.useRef)(/* @__PURE__ */ new Set());
			const closed = (0, react.useRef)(false);
			const current = (0, react.useRef)({
				phase,
				messages
			});
			current.current = {
				phase: current.current.phase,
				messages
			};
			const setPhase = (next) => {
				current.current.phase = next;
				setPhaseState(next);
			};
			const dictation = useDictation((text, final) => {
				if (final) heardText.current += text;
				setCaption(final ? heardText.current : heardText.current + text);
			});
			const listen = () => {
				if (closed.current) return;
				heardText.current = "";
				setCaption("");
				setPhase("listening");
				dictation.start({
					continuous: false,
					onError: (message) => {
						setNote(message);
						setPhase("unsupported");
					},
					onEnd: () => {
						if (closed.current || current.current.phase !== "listening") return;
						const said = heardText.current.trim();
						if (!said) {
							setTimeout(listen, 300);
							return;
						}
						known.current = new Set(current.current.messages.filter((message) => message.role === "superagent").map((message) => message.id));
						setPhase("thinking");
						send(said).then((ok) => {
							if (!ok && !closed.current) listen();
						});
					}
				});
			};
			const speak = (text) => {
				setCaption(text);
				const synth = typeof window.speechSynthesis === "undefined" ? void 0 : window.speechSynthesis;
				if (!synth || typeof SpeechSynthesisUtterance === "undefined") {
					setTimeout(listen, 1500);
					return;
				}
				setPhase("speaking");
				const utterance = new SpeechSynthesisUtterance(plainSpeech(text).slice(0, 1200));
				utterance.lang = navigator.language || "zh-CN";
				utterance.onend = () => {
					if (!closed.current) listen();
				};
				synth.cancel();
				synth.speak(utterance);
			};
			(0, react.useEffect)(() => {
				if (phase === "listening") listen();
				return () => {
					closed.current = true;
					dictation.abort();
					window.speechSynthesis?.cancel();
				};
			}, []);
			(0, react.useEffect)(() => {
				if (phase !== "thinking") return;
				const answer = messages.find((message) => message.role === "superagent" && !known.current.has(message.id));
				if (answer) speak(answer.text);
			}, [messages, phase]);
			(0, react.useEffect)(() => {
				if (phase !== "thinking") return void 0;
				const timer = setTimeout(() => {
					setNote(t("voice.slow"));
					listen();
				}, 12e4);
				return () => clearTimeout(timer);
			}, [phase]);
			const pause = () => {
				dictation.abort();
				window.speechSynthesis?.cancel();
				setPhase("paused");
			};
			const end = () => {
				closed.current = true;
				dictation.abort();
				window.speechSynthesis?.cancel();
				onClose();
			};
			const button = (label, onClick, children, className = "dt-voice-btn") => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
				type: "button",
				className,
				"aria-label": label,
				title: label,
				onClick,
				children
			});
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "dt-voice",
				role: "dialog",
				"aria-label": t("composer.voiceTitle"),
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "dt-voice-stage",
					"data-phase": phase,
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "dt-voice-orb",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: "dt-voice-ring" }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "dt-voice-mark",
								"aria-hidden": "true",
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(WaveIcon, { size: 34 })
							})]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: "dt-voice-name",
							children: t("chat.supervisor")
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: "dt-voice-status",
							role: "status",
							children: t(`voice.${phase}`)
						}),
						caption && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: "dt-voice-caption",
							children: caption
						}),
						note && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: "dt-voice-note",
							children: note
						})
					]
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "dt-voice-bar",
					children: [phase === "paused" || phase === "unsupported" ? phase === "paused" && button(t("voice.resume"), () => {
						setNote("");
						listen();
					}, /* @__PURE__ */ (0, react_jsx_runtime.jsx)(MicIcon, {})) : button(t("voice.pause"), pause, /* @__PURE__ */ (0, react_jsx_runtime.jsx)(MicIcon, {})), button(t("voice.end"), end, /* @__PURE__ */ (0, react_jsx_runtime.jsx)(CloseIcon, {}), "dt-voice-btn dt-voice-end")]
				})]
			});
		}
		//#endregion
		//#region src/client/review.tsx
		/**
		* VsSaros addition: the review of a ticket's shelved changelist, the only way to submit to P4. A person opens every file's
		* difference, confirms, and approves the fingerprint of what they read; or sends the CL back with a comment, or discards it.
		*/
		function DiffLines({ diff }) {
			const { t } = usePanel();
			if (!diff.lines.length) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Hint, { children: t("review.binary") });
			const tone = (line) => line.startsWith("@@") ? "hunk" : line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : "ctx";
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("pre", {
				className: "dt-diff",
				children: diff.lines.map((line, index) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
					className: `dt-diff-${tone(line)}`,
					children: [line || " ", "\n"]
				}, index))
			}), diff.truncated && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Hint, { children: t("review.truncated") })] });
		}
		/** A finished review's one line, or the error of a failed submit on a waiting one. */
		function Outcome({ review }) {
			const { t } = usePanel();
			const by = review.by ?? "";
			switch (review.state) {
				case "handed": return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Hint, { children: t("review.state.handed", { by }) });
				case "submitted": return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Hint, { children: t("review.state.submitted", {
					by,
					submitted: String(review.submittedAs ?? "")
				}) });
				case "rejected": return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Hint, { children: t("review.state.rejected", {
					by,
					comment: review.comment ?? ""
				}) });
				case "discarded": return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Hint, { children: t("review.state.discarded", { by }) });
				case "submitting": return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Hint, { children: t("review.state.submitting") });
				default: return null;
			}
		}
		/** The review section of a ticket's page; renders nothing for a ticket without a changelist review. */
		function ReviewSection({ id, onChanged }) {
			const { t, call } = usePanel();
			const { data, reload } = usePoll(() => call("GET tickets/:id/review", { id }), [id], 1e4);
			if (!data || data.review === null) return null;
			const { review } = data;
			const title = t("review.section", { change: String(review.change) });
			if (review.state !== "waiting") return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Section, {
				title,
				icon: "review",
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Outcome, { review })
			});
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(WaitingReview, {
				id,
				view: data,
				title,
				after: async () => {
					await reload();
					await onChanged();
				}
			}, review.fingerprint);
		}
		function WaitingReview({ id, view, title, after }) {
			const { t, call } = usePanel();
			const { review, diffs, submit } = view;
			const [seen, setSeen] = (0, react.useState)({});
			const [open, setOpen] = (0, react.useState)();
			const [ack, setAck] = (0, react.useState)(false);
			const [confirming, setConfirming] = (0, react.useState)(false);
			const [rejecting, setRejecting] = (0, react.useState)(false);
			const [comment, setComment] = (0, react.useState)("");
			const [changed, setChanged] = (0, react.useState)([]);
			const ackId = (0, react.useId)();
			const approve = useAction(async () => {
				try {
					await call("POST tickets/:id/review/approve", {
						id,
						body: { fingerprint: review.fingerprint }
					});
				} catch (failure) {
					if (failure instanceof ApiError && failure.status === 409) setChanged(failure.details.changed ?? []);
					setConfirming(false);
					throw failure;
				}
				setConfirming(false);
			}, { reload: after });
			const reject = useAction(async () => {
				await call("POST tickets/:id/review/reject", {
					id,
					body: { comment: comment.trim() }
				});
				setRejecting(false);
				setComment("");
			}, { reload: after });
			const all = diffs.length > 0 && diffs.every((diff) => seen[diff.depotFile]);
			const toggle = (file) => {
				setOpen(open === file ? void 0 : file);
				setSeen((current) => ({
					...current,
					[file]: true
				}));
			};
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(Section, {
				title,
				icon: "review",
				badge: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Tag, {
					tone: "info",
					children: t("review.seen", {
						seen: String(Object.keys(seen).length),
						total: String(diffs.length)
					})
				}),
				children: [
					review.error && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: "dt-banner dt-danger",
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "dt-banner-label",
							children: t("review.lastError", { error: review.error })
						})
					}),
					changed.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dt-banner dt-danger",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "dt-banner-label",
							children: t("review.changed")
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("ul", {
							className: "dt-plain-list dt-mono",
							children: changed.map((file) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("li", { children: file }, file))
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(KeyValues, { rows: [
						[t("review.description"), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("pre", {
							className: "dt-review-desc",
							children: review.description.trim()
						})],
						[t("review.workspace"), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "dt-mono",
							children: review.client
						})],
						[t("review.fingerprint"), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "dt-mono",
							children: review.fingerprint
						})]
					] }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Hint, { children: t("review.filesHint") }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "dt-review-files",
						children: diffs.map((diff) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(DisclosureRow, {
							open: open === diff.depotFile,
							onToggle: () => toggle(diff.depotFile),
							icon: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Icon, { name: seen[diff.depotFile] ? "decision" : "hash" }),
							title: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								className: "dt-mono",
								children: [
									diff.depotFile,
									"#",
									diff.rev,
									" ",
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
										className: "dt-hint",
										children: [
											"(",
											diff.type,
											")"
										]
									})
								]
							}),
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "dt-disclosure-body",
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(DiffLines, { diff })
							})
						}, diff.depotFile))
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dt-review-ack",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
							id: ackId,
							type: "checkbox",
							checked: ack,
							disabled: !all,
							onChange: (event) => setAck(event.target.checked)
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
							htmlFor: ackId,
							children: t("review.ack")
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dt-row-buttons",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Button, {
								variant: "primary",
								size: "sm",
								disabled: !all || !ack || approve.busy,
								onClick: () => setConfirming(true),
								children: t("review.approve")
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Button, {
								variant: "outline",
								size: "sm",
								onClick: () => setRejecting(true),
								children: t("review.reject")
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(ConfirmButton, {
								variant: "outline",
								label: t("review.discard"),
								title: t("review.discardTitle", { change: String(review.change) }),
								message: t("review.discardConfirm"),
								onConfirm: async () => {
									await call("POST tickets/:id/review/discard", { id });
									await after();
								}
							})
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Modal, {
						open: confirming,
						onClose: () => setConfirming(false),
						closeLabel: t("close"),
						title: t("review.approveTitle", { change: String(review.change) }),
						description: submit.mode === "pipeline" ? t("review.approvePipeline", { tags: submit.tags }) : t("review.approveHost"),
						footer: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Button, {
							variant: "ghost",
							onClick: () => setConfirming(false),
							children: t("cancel")
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Button, {
							variant: "primary",
							disabled: approve.busy,
							onClick: () => {
								approve.run();
							},
							children: t("confirm")
						})] })
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Modal, {
						open: rejecting,
						onClose: () => setRejecting(false),
						closeLabel: t("close"),
						title: t("review.rejectTitle", { change: String(review.change) }),
						description: t("review.rejectHint"),
						footer: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Button, {
							variant: "ghost",
							onClick: () => setRejecting(false),
							children: t("cancel")
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Button, {
							variant: "primary",
							disabled: !comment.trim() || reject.busy,
							onClick: () => {
								reject.run();
							},
							children: t("review.reject")
						})] }),
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("textarea", {
							className: "dt-textarea",
							rows: 4,
							value: comment,
							placeholder: t("review.rejectPlaceholder"),
							"aria-label": t("review.rejectTitle", { change: String(review.change) }),
							onChange: (event) => setComment(event.target.value)
						})
					})
				]
			});
		}
		/** The reviews waiting for a person, for the Overview; renders nothing when none waits. */
		function PendingReviews() {
			const { t, call, navigate } = usePanel();
			const { data } = usePoll(() => call("GET reviews"), [], 1e4);
			if (!data?.waiting.length) return null;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Section, {
				title: t("review.pending"),
				count: data.waiting.length,
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("ul", {
					className: "dt-list dt-cards",
					children: data.waiting.map((review) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", {
						className: "dt-row dt-link",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "dt-row-main",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "dt-row-title",
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: "dt-open",
									onClick: () => navigate({
										page: "execution",
										id: review.ticketId
									}),
									children: review.description.split("\n")[0]?.trim() || `CL ${review.change}`
								})
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "dt-row-meta",
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("review.waitingLine", {
									change: String(review.change),
									files: String(review.files.length),
									time: when(review.requestedAt, t("lang"))
								}) })
							})]
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: "dt-row-actions",
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Button, {
								variant: "outline",
								size: "sm",
								icon: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Icon, {
									name: "review",
									size: 14
								}),
								onClick: () => navigate({
									page: "execution",
									id: review.ticketId
								}),
								children: t("review.open")
							})
						})]
					}, review.ticketId))
				})
			});
		}
		//#endregion
		//#region src/client/team-plans.tsx
		/**
		* VsSaros addition: the Overview's team work — requests and teams waiting for a person, team steps, skill drafts from the
		* memory system, Bot drafts — and, read-only, the retired team plans (2026-11-06).
		* ★ 2026-11-09: the reusable-workflows / TeamFlow section was removed from this panel (user request); the Host-side
		*   workflow data and adapter remain, so team staffing can still reuse saved workflows.
		*/
		/**
		* VsSaros addition (2026-11-06): what a team used of its budget. Its token and turn caps are hard gates; at either one, no
		* new step starts until a person raises it here (by half again).
		*/
		function TeamBudget({ ticketId, budget }) {
			const { t, call } = usePanel();
			const reached = budget.stopped || budget.turns >= budget.turnsCap;
			const raise = useAction(() => call("POST tickets/:id/steps/budget", {
				id: ticketId,
				body: {
					tokens: Math.max(budget.tokensCap, budget.tokens) + Math.ceil(Math.max(budget.tokensCap, 1e4) / 2),
					turns: Math.max(budget.turnsCap, budget.turns) + Math.ceil(Math.max(budget.turnsCap, 2) / 2)
				}
			}));
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "dt-row-meta",
				"data-testid": "team-budget",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("team.budgetLine", {
						tokens: String(budget.tokens),
						tokensCap: String(budget.tokensCap),
						turns: String(budget.turns),
						turnsCap: String(budget.turnsCap)
					}) }),
					reached && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "dt-tag",
						"data-tone": "warning",
						children: t("team.budgetReached")
					}),
					reached && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Button, {
						variant: "outline",
						size: "sm",
						disabled: raise.busy,
						onClick: () => {
							raise.run();
						},
						children: t("team.budgetRaise")
					})
				]
			});
		}
		/** Renders nothing when no plan, no draft and no retrospective output exists. */
		function TeamPlans() {
			const { t, call, navigate } = usePanel();
			const plans = usePoll(() => call("GET team/plans"), [], 5e3);
			const drafts = usePoll(() => call("GET team/approvals"), [], 1e4);
			const retro = usePoll(() => call("GET team/retrospective"), [], 1e4);
			const approveBot = useAction((id) => call("POST team/approvals/:id/approve", { id }), { reload: drafts.reload });
			const rejectBot = useAction((id) => call("POST team/approvals/:id/reject", { id }), { reload: drafts.reload });
			const waiting = drafts.data?.waiting ?? [];
			const archivedSkills = retro.data?.skills ?? [];
			const work = useWork();
			const teams = work.proposals ?? [];
			const teamTickets = work.teams;
			const distills = usePoll(() => call("GET team/distills"), [], 15e3);
			const approveDraft = useAction((id) => call("POST team/distills/:id/approve", { id }), { reload: distills.reload });
			const rejectDraft = useAction((id) => call("POST team/distills/:id/reject", { id }), { reload: distills.reload });
			const drafts2 = (distills.data?.distills ?? []).filter((item) => item.result?.skill?.state === "draft" && item.result.skill.created);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
				work.approvals.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Section, {
					title: t("work.needsYou"),
					count: work.approvals.length,
					children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "dt-approvals",
						"data-testid": "step-approvals",
						children: work.approvals.map((item) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ApprovalCard, { approval: item }, item.id))
					})
				}),
				teams.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Section, {
					title: t("team.staffing"),
					count: teams.length,
					children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(StaffingList, { teams })
				}),
				teamTickets.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Section, {
					title: t("team.steps"),
					count: teamTickets.length,
					children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("ul", {
						className: "dt-list dt-cards",
						"data-testid": "team-steps",
						children: teamTickets.map((team) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("li", {
							className: "dt-row dt-team-run",
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "dt-row-main",
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: "dt-row-title",
										children: [
											team.ticket.title,
											" ",
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												className: "dt-tag",
												"data-tone": "neutral",
												children: t("team.stepsDone", {
													done: String(team.steps.filter((step) => step.state === "ready").length),
													total: String(team.steps.length)
												})
											})
										]
									}),
									team.budget && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(TeamBudget, {
										ticketId: team.ticket.id,
										budget: team.budget
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)(MiniFlow, {
										team,
										onOpen: () => navigate({
											page: "execution",
											query: { ticket: team.ticket.id }
										})
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)(StepMembers, { team })
								]
							})
						}, team.ticket.id))
					})
				}),
				drafts2.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Section, {
					title: t("team.distillPending"),
					count: drafts2.length,
					children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("ul", {
						className: "dt-list dt-cards",
						"data-testid": "team-distills",
						children: drafts2.map((item) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", {
							className: "dt-row dt-link",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "dt-row-main",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "dt-row-title",
									children: [
										item.stepTitle,
										" ",
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: "dt-tag",
											"data-tone": "neutral",
											children: item.botName
										}),
										item.result.skill.version && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
											className: "dt-tag",
											"data-tone": "outline",
											children: [
												"v",
												item.result.skill.version,
												item.result.skill.updates === "active" ? ` · ${t("team.distillNewVersion")}` : ""
											]
										}),
										item.result.skill.risk && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: "dt-tag",
											"data-tone": item.result.skill.risk === "low" ? "neutral" : "warning",
											title: item.result.skill.riskReasons?.join("；"),
											children: t(`team.distillRisk.${item.result.skill.risk}`)
										}),
										item.result.skill.distilled === false && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: "dt-tag",
											"data-tone": "warning",
											title: item.result.skill.distillError,
											children: t("team.distillTemplate")
										})
									]
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "dt-row-meta",
									children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: item.result.skill.name }),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: item.reasons.join(" · ") }),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: item.evidence.report.slice(0, 100) })
									]
								})]
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "dt-row-actions",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Button, {
									variant: "primary",
									size: "sm",
									disabled: approveDraft.busy,
									onClick: () => {
										approveDraft.run(item.id);
									},
									children: t("team.skillApprove")
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Button, {
									variant: "outline",
									size: "sm",
									disabled: rejectDraft.busy,
									onClick: () => {
										rejectDraft.run(item.id);
									},
									children: t("team.skillReject")
								})]
							})]
						}, item.id))
					})
				}),
				archivedSkills.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Hint, { children: t("team.skillsArchived", { count: String(archivedSkills.length) }) }),
				waiting.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Section, {
					title: t("team.approval"),
					count: waiting.length,
					children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("ul", {
						className: "dt-list dt-cards",
						children: waiting.map((draft) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", {
							className: "dt-row dt-link",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "dt-row-main",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "dt-row-title",
									children: [
										draft.draft.name,
										" ",
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: "dt-tag",
											"data-tone": "warning",
											children: draft.draft.id
										})
									]
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "dt-row-meta",
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("team.approvalLine", { risk: draft.risk.join(", ") }) }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: draft.draft.description })]
								})]
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "dt-row-actions",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Button, {
									variant: "primary",
									size: "sm",
									disabled: approveBot.busy,
									onClick: () => {
										approveBot.run(draft.id);
									},
									children: t("team.approve")
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Button, {
									variant: "outline",
									size: "sm",
									disabled: rejectBot.busy,
									onClick: () => {
										rejectBot.run(draft.id);
									},
									children: t("team.reject")
								})]
							})]
						}, draft.id))
					})
				}),
				drafts.data && drafts.data.created.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Hint, { children: t("team.created", {
					count: String(drafts.data.created.length),
					global: String(drafts.data.global),
					perPlan: String(drafts.data.perPlan)
				}) }),
				!plans.data?.plans.length ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(Section, {
					title: t("team.archivedPlans"),
					count: plans.data.plans.length,
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Hint, { children: t("team.archivedPlansHint") }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("ul", {
						className: "dt-list dt-cards",
						"data-testid": "team-archived-plans",
						children: plans.data.plans.slice(0, 3).map((plan) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("li", {
							className: "dt-row dt-link",
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "dt-row-main",
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: "dt-row-title",
										children: [
											plan.goal,
											" ",
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												className: "dt-tag",
												"data-tone": "neutral",
												children: t(`team.state.${plan.status}`)
											})
										]
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: "dt-row-meta",
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("team.running", { running: String(plan.running) }) }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: plan.bots.join(" · ") })]
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("ul", {
										className: "dt-list",
										children: plan.steps.map((step) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("li", {
											className: "dt-row",
											children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
												className: "dt-row-main",
												children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
													className: "dt-row-title",
													children: t("team.step", {
														step: step.id,
														title: step.title,
														bot: step.botName ?? step.bot
													})
												}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
													className: "dt-row-meta",
													children: [
														/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t(`team.state.${step.state}`) }),
														step.after.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("team.after", { after: step.after.join(", ") }) }),
														step.report && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: step.report.length > 120 ? `${step.report.slice(0, 120)}…` : step.report }),
														step.error && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: step.error })
													]
												})]
											})
										}, step.id))
									})
								]
							})
						}, plan.id))
					})]
				})
			] });
		}
		//#endregion
		//#region src/client/overview.tsx
		function ProblemLine({ problem, onChanged }) {
			const { t, call, navigate } = usePanel();
			const post = useAction((request) => request(), { reload: onChanged });
			const row = (title, detail, route, hint, actions) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("li", {
				className: "dt-row dt-link dt-att dt-att-error",
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "dt-row-main",
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: "dt-att-what",
							children: route ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: "dt-open dt-open-wrap",
								onClick: () => navigate(route),
								children: title
							}) : title
						}),
						detail,
						hint && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Hint, { children: hint }),
						actions && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: "dt-row-meta dt-row-buttons",
							children: actions
						})
					]
				})
			});
			const go = (label, route) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Button, {
				variant: "outline",
				size: "sm",
				icon: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Icon, {
					name: "settings",
					size: 14
				}),
				onClick: () => navigate(route),
				children: label
			});
			const raw = (text) => text && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
				className: "dt-error dt-clamp dt-mono",
				children: text
			});
			const worded = (text) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
				className: "dt-error",
				children: text
			});
			switch (problem.kind) {
				case "setup": return row(t(problem.place === "feishu" ? "problemSetupFeishu" : "problemSetup"), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
					className: "dt-error",
					children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(SetupMessage, { problem })
				}), setupPage(problem.place), t(`problemSetupFix.${problem.place}`), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(CheckSetupButton, {}));
				case "no-source": return row(t("problemNoSource"), void 0, settingsRoute("source"), void 0, go(t("actionOpenSources"), settingsRoute("source")));
				case "no-allowed": return row(t("problemNoAllowed"), void 0, settingsRoute("eval"), void 0, go(t("actionAddAllowed"), settingsRoute("eval")));
				case "executor-paused": return row(t("problemPaused"), void 0, { page: "execution" }, void 0, /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ConfirmButton, {
					variant: "outline",
					icon: "play",
					label: t("resumeProcessing"),
					title: t("resumeProcessing"),
					message: t("resumeProcessingConfirm"),
					onConfirm: async () => {
						await call("POST executor/pause", { body: { paused: false } });
						await onChanged();
					}
				}));
				case "runtime-error": return row(t("problemRuntime", { name: valueLabel(t, "health", problem.name) }), raw(problem.detail), void 0);
				case "source-error": {
					const health = problem.source.health;
					return row(t("sourceError", { source: localized(t, problem.source.title) }), health.code ? worded(healthText(t, health)) : raw(health.detail), { page: "source" }, t("sourceErrorHint"));
				}
				case "eval-overdue": return row(t("problemEvalOverdue", { thread: readableMarkers(t, problem.thread.title) }), void 0, {
					page: "trigger",
					id: problem.thread.key
				});
				case "eval-unavailable": return row(t("problemEvalUnavailable", { thread: readableMarkers(t, problem.thread.title) }), raw(reasonLabel(t, problem.reason)), {
					page: "trigger",
					id: problem.thread.key,
					query: { trigger: problem.triggerId }
				}, void 0, /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Button, {
					variant: "outline",
					size: "sm",
					icon: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Icon, {
						name: "refresh",
						size: 14
					}),
					disabled: post.busy,
					onClick: () => {
						post.run(() => call("POST triggers/:id/requeue", { id: problem.triggerId }));
					},
					children: t("requeue")
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Button, {
					variant: "outline",
					size: "sm",
					icon: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Icon, {
						name: "dismiss",
						size: 14
					}),
					disabled: post.busy,
					onClick: () => {
						post.run(() => call("POST decisions/:id/dismiss", { id: problem.decisionId }));
					},
					children: t("dismiss")
				})] }));
				case "outgoing": return row(t("problemReply", {
					source: valueLabel(t, "source", problem.outgoing.channel.source),
					attempts: problem.outgoing.attempts
				}), raw(problem.outgoing.error), void 0);
			}
		}
		function OverviewPage() {
			const { t, call, navigate } = usePanel();
			const { setup } = usePanelData();
			const { data, error, reload } = usePoll(() => call("GET overview"), []);
			if (!data) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(LoadState, {
				error,
				loading: true
			});
			const stat = (label, value, route) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
				className: "dt-stat",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: "dt-stat-label",
					children: label
				}), route ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
					type: "button",
					className: "dt-textlink dt-stat-value",
					onClick: () => navigate(route),
					children: value
				}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: "dt-stat-value",
					children: value
				})]
			});
			const more = (route) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
				type: "button",
				className: "dt-textlink dt-more-link",
				onClick: () => navigate(route),
				children: t("details")
			});
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
				error && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(LoadState, {
					error,
					loading: false
				}),
				data.coexist?.dsBot && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "dt-hint",
					"data-testid": "coexist-ds-bot",
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", { children: t("coexistDsBot") }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("ul", {
						className: "dt-list",
						children: data.coexist.dsBot.effects.map((effect) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("li", { children: t(`coexistEffect.${effect}`) }, effect))
					})]
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)(PendingReviews, {}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)(TeamPlans, {}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Section, {
					title: t("pendingTickets"),
					count: data.person.length,
					children: data.person.length ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("ul", {
						className: "dt-list dt-cards",
						children: data.person.map((ticket) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(TicketLine, {
							ticket,
							question: true,
							onChanged: reload
						}, ticket.id))
					}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Hint, { children: t("needsYouNone") })
				}),
				data.problems.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Section, {
					title: t("problems"),
					count: data.problems.length,
					children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("ul", {
						className: "dt-list dt-cards",
						children: data.problems.map((problem, index) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ProblemLine, {
							problem,
							onChanged: reload
						}, index))
					})
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Section, {
					title: t("lastDay"),
					action: more({
						page: "trigger",
						query: { filter: "recent" }
					}),
					children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dt-stats",
						children: [
							stat(t("flowReceivedLabel"), data.flow.received),
							stat(t("flowFilteredLabel"), data.flow.filtered, data.flow.filtered ? { page: "source" } : void 0),
							stat(t("flowJudgedLabel"), data.flow.judged),
							stat(t("flowAcceptedLabel"), data.flow.accepted, {
								page: "eval",
								query: { window: "24h" }
							}),
							data.flow.dropped > 0 && stat(t("flowDroppedLabel"), data.flow.dropped, { page: "source" })
						]
					})
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Section, {
					title: t("term.executor"),
					action: more({ page: "execution" }),
					children: setup?.problem ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Hint, { children: t("executorWaitingSetup") }) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dt-stats",
						children: [
							stat(t("executingLabel"), `${data.executor.running} / ${data.executor.maxWorkers}`),
							stat(t("queuedLabel"), data.executor.queued),
							stat(t("idleLabel"), data.executor.idle)
						]
					})
				})
			] });
		}
		//#endregion
		//#region src/client/side.tsx
		/**
		* VsSaros addition: the side panel beside the page, with the Overview in it. It opens and closes from the header, keeps its
		* width (dragged from its left edge) and open state across panel loads, and opens by itself when the supervisor starts new
		* work: a new version of a team proposal, a team ticket whose steps begin, or a step asking the person to approve a call
		* beyond its directory (plan C). Closing it by hand is respected: the same work progressing does not open it again, only new
		* work does.
		*/
		const SIDE_KEY = "dsh-superagent/side";
		const SEEN_KEY = "dsh-superagent/side-seen";
		const SIDE_WIDTH = {
			min: 320,
			max: 560,
			initial: 400
		};
		const clampWidth = (value) => Math.round(Math.min(SIDE_WIDTH.max, Math.max(SIDE_WIDTH.min, value)));
		function readStored(key) {
			try {
				return JSON.parse(localStorage.getItem(key) ?? "null") ?? void 0;
			} catch {
				return;
			}
		}
		function writeStored(key, value) {
			try {
				localStorage.setItem(key, JSON.stringify(value));
			} catch (failure) {}
		}
		const SideContext = (0, react.createContext)(void 0);
		function useSide() {
			const value = (0, react.useContext)(SideContext);
			if (!value) throw new Error("dsh-superagent side panel used outside its provider");
			return value;
		}
		/** What the supervisor is working on, one signature per piece of new work; a step's request for the person counts as new work. */
		function workSignatures(proposals, teams, approvals = []) {
			return [
				...proposals.flatMap((item) => item.proposal ? [`proposal:${item.ticket.id}:v${item.proposal.version}`] : []),
				...teams.map((item) => `steps:${item.ticket.id}`),
				...approvals.map((item) => `approval:${item.id}`)
			];
		}
		/** Holds the side panel's state and opens it when the supervisor starts new work or a step asks the person. */
		function SideProvider({ children }) {
			const { t, notify } = usePanel();
			const work = useWork();
			const stored = (0, react.useMemo)(() => readStored(SIDE_KEY) ?? {}, []);
			const [open, setOpenState] = (0, react.useState)(stored.open ?? true);
			const [width, setWidthState] = (0, react.useState)(clampWidth(stored.width ?? SIDE_WIDTH.initial));
			const latest = (0, react.useRef)({
				open,
				width
			});
			latest.current = {
				open,
				width
			};
			const setOpen = (0, react.useCallback)((next) => {
				setOpenState(next);
				writeStored(SIDE_KEY, {
					...latest.current,
					open: next
				});
			}, []);
			const setWidth = (0, react.useCallback)((next) => {
				const value = clampWidth(next);
				setWidthState(value);
				writeStored(SIDE_KEY, {
					...latest.current,
					width: value
				});
			}, []);
			const seen = (0, react.useRef)(void 0);
			(0, react.useEffect)(() => {
				if (!work.loaded || !work.proposals) return;
				const now = workSignatures(work.proposals, work.teams, work.approvals);
				if (!seen.current) {
					const remembered = readStored(SEEN_KEY);
					seen.current = new Set(remembered ?? now);
					if (!remembered) {
						writeStored(SEEN_KEY, now);
						return;
					}
				}
				const fresh = now.filter((signature) => !seen.current.has(signature));
				if (!fresh.length) return;
				for (const signature of fresh) seen.current.add(signature);
				writeStored(SEEN_KEY, [...seen.current].slice(-200));
				if (!latest.current.open) {
					setOpen(true);
					notify(t(fresh.some((signature) => signature.startsWith("approval:")) ? "side.autoOpenedApproval" : "side.autoOpened"));
				}
			}, [
				work.loaded,
				work.proposals,
				work.teams,
				work.approvals,
				setOpen,
				notify,
				t
			]);
			const value = (0, react.useMemo)(() => ({
				open,
				width,
				setOpen,
				setWidth
			}), [
				open,
				width,
				setOpen,
				setWidth
			]);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(SideContext.Provider, {
				value,
				children
			});
		}
		/** The side panel itself: a tab strip with the main Session and close buttons, and the Overview. */
		function SidePanel({ masterId }) {
			const { t, openSession, notify } = usePanel();
			const { open, width, setOpen, setWidth } = useSide();
			const [dragging, setDragging] = (0, react.useState)(false);
			if (!open) return null;
			const drag = (event) => {
				const grip = event.currentTarget, start = event.clientX, from = width;
				grip.setPointerCapture?.(event.pointerId);
				setDragging(true);
				const move = (next) => setWidth(from + start - next.clientX);
				const up = () => {
					grip.removeEventListener("pointermove", move);
					setDragging(false);
				};
				grip.addEventListener("pointermove", move);
				grip.addEventListener("pointerup", up, { once: true });
			};
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("aside", {
				className: "dt-side",
				"data-dragging": dragging || void 0,
				"aria-label": t("tab.overview"),
				style: { ["--dt-side-width"]: `${width}px` },
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "dt-side-grip",
						role: "separator",
						"aria-orientation": "vertical",
						"aria-label": t("side.resize"),
						"aria-valuemin": SIDE_WIDTH.min,
						"aria-valuemax": SIDE_WIDTH.max,
						"aria-valuenow": width,
						tabIndex: 0,
						onPointerDown: drag,
						onKeyDown: (event) => {
							if (event.key === "ArrowLeft") setWidth(width + 16);
							if (event.key === "ArrowRight") setWidth(width - 16);
						}
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dt-side-strip",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "dt-side-tab",
							children: t("tab.overview")
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "dt-side-tools",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Button, {
								variant: "ghost",
								size: "sm",
								icon: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Icon, {
									name: "session",
									size: 15
								}),
								"aria-label": t("openMaster"),
								title: t("openMaster"),
								disabled: !masterId,
								onClick: () => {
									if (masterId) openSession(masterId).catch((failure) => notify(errorText(failure)));
								}
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Button, {
								variant: "ghost",
								size: "sm",
								icon: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Icon, {
									name: "panel",
									size: 15
								}),
								"aria-label": t("side.close"),
								title: t("side.close"),
								onClick: () => setOpen(false)
							})]
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "dt-side-body",
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(OverviewPage, {})
					})
				]
			});
		}
		//#endregion
		//#region src/client/chat.tsx
		/**
		* VsSaros addition: the Chat tab, the supervisor desk's conversation. In a VsSaros workbench it is DSH's own chat for the desk
		* Session (its messages and composer), which the workbench host docks here: a message typed in it is the person talking to
		* SuperAgent, and goes through the same gate, Eval and tickets, so replying「同意」agrees to a team proposal. Elsewhere,
		* where no host docks a conversation, the panel draws the conversation itself: the desk's messages, quick replies on a
		* proposal that waits, and a composer after DeepSeek-Bot's (see `composer.tsx`).
		*/
		const PROPOSAL = /^【组队方案 v\d+】/;
		/** The proposal message that still waits for the person: the latest one with no message of theirs after it. */
		function waitingProposal(messages) {
			for (let index = messages.length - 1; index >= 0; index -= 1) {
				const message = messages[index];
				if (message.role === "person") return void 0;
				if (PROPOSAL.test(message.text)) return message.id;
			}
		}
		const NativeContext = (0, react.createContext)(void 0);
		/** The Chat tab: DSH's own chat for the desk where a host docks one, else the panel's. */
		function ChatTab() {
			const native = (0, react.useContext)(NativeContext);
			return native ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(NativeChat, { native }) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ChatPage, {});
		}
		/** DSH's chat of the desk Session; on failing to dock it, the panel's chat with why. */
		function NativeChat({ native }) {
			const { t } = usePanel();
			const { state } = usePanelData();
			const deskId = state?.deskId;
			const [failure, setFailure] = (0, react.useState)("");
			const { dock, active } = native;
			(0, react.useEffect)(() => {
				if (!deskId || !active) return void 0;
				let live = true;
				dock(deskId).then(() => {
					if (live) setFailure("");
				}, (error) => {
					if (live) setFailure(errorText(error));
				});
				return () => {
					live = false;
				};
			}, [
				deskId,
				active,
				dock
			]);
			if (failure) return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
				className: "dt-error",
				role: "alert",
				children: t("chat.nativeFailed", { error: failure })
			}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ChatPage, {})] });
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "dt-chat dt-native-chat",
				"data-testid": "native-chat",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(ChatDock, {}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: "dt-native-wait",
						children: t("chat.nativeOpening")
					}),
					native.node
				]
			});
		}
		/**
		* VsSaros fix (2026-11-05): what waits for the person, above the desk's conversation: a team to agree to and a step's
		* request. The desk's model tells the person of them in words, but the buttons here do not depend on what it says or on
		* whether it is up, and they act on the ticket whichever desk it began in.
		*/
		function ChatDock() {
			const { t } = usePanel();
			const work = useWork();
			const teams = (work.proposals ?? []).filter((item) => item.proposal);
			if (!teams.length && !work.approvals.length) return null;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
				className: "dt-chat-dock",
				"aria-label": t("chat.dock"),
				"data-testid": "chat-dock",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h2", {
						className: "dt-chat-dock-title",
						children: t("chat.dock")
					}),
					work.approvals.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "dt-approvals",
						children: work.approvals.map((item) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ApprovalCard, { approval: item }, item.id))
					}),
					teams.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(StaffingList, { teams })
				]
			});
		}
		const placementLabel = (t, item) => item.state === "failed" ? t("chat.sendFailed") : item.placement === "queued" ? t("chat.queued") : t("chat.pending");
		/** The panel's own drawing of the desk conversation, where no host docks DSH's. */
		function ChatPage() {
			const { t, call, notify } = usePanel();
			const { setOpen } = useSide();
			const [voice, setVoice] = (0, react.useState)(false);
			const { data, error, reload } = usePoll(() => call("GET desk/messages"), [], voice ? 1500 : 3e3);
			const end = (0, react.useRef)(null);
			const [locals, setLocals] = (0, react.useState)([]);
			const inFlight = (0, react.useRef)(0);
			const seq = (0, react.useRef)(0);
			const pending = locals.filter((item) => item.state === "pending");
			const count = (data?.messages.length ?? 0) + locals.length;
			(0, react.useEffect)(() => {
				if (count) end.current?.scrollIntoView?.({ block: "end" });
			}, [count]);
			const send = (body) => {
				const text = body.trim();
				if (!text) return Promise.resolve(false);
				const placement = inFlight.current > 0 ? "queued" : "transcript";
				const id = `local:${++seq.current}:${Date.now()}`;
				const at = (/* @__PURE__ */ new Date()).toISOString();
				inFlight.current += 1;
				setLocals((items) => [...items, {
					id,
					text,
					at,
					placement,
					state: "pending"
				}]);
				return (async () => {
					try {
						if ((await call("POST desk/messages", { body: { text } })).result === "filtered") notify(t("chat.filtered"));
						try {
							await reload();
						} catch {}
						setLocals((items) => items.filter((item) => item.id !== id));
						return true;
					} catch (failure) {
						notify(errorText(failure));
						setLocals((items) => items.map((item) => item.id === id ? {
							...item,
							state: "failed"
						} : item));
						return false;
					} finally {
						inFlight.current = Math.max(0, inFlight.current - 1);
					}
				})();
			};
			if (!data) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(LoadState, {
				error,
				loading: true
			});
			if (voice) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: "dt-chat",
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(VoicePane, {
					messages: data.messages,
					send,
					onClose: () => setVoice(false)
				})
			});
			const waiting = waitingProposal(data.messages);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "dt-chat",
				children: [
					error && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(LoadState, {
						error,
						loading: false
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dt-chat-log",
						role: "log",
						"aria-label": t("tab.chat"),
						children: [
							!data.messages.length && !locals.length && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Hint, { children: t("chat.empty") }),
							data.messages.map((message) => message.role === "person" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "dt-msg dt-msg-person",
								"data-source": message.source,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: "dt-msg-bubble",
									children: message.text
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "dt-msg-meta",
									children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)(When, { at: message.at }),
										message.source === "feishu" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: "dt-tag",
											"data-source": "feishu",
											children: "飞书"
										}),
										message.filtered && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: "dt-msg-filtered",
											children: t("chat.notHanded", { reason: reasonLabel(t, message.filtered) })
										})
									]
								})]
							}, message.id) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "dt-msg dt-msg-agent",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "dt-msg-avatar",
									"aria-hidden": "true",
									children: "SA"
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "dt-msg-main",
									children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
											className: "dt-msg-who",
											children: [
												t("chat.supervisor"),
												" · ",
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)(When, { at: message.at }),
												message.id === waiting && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
													className: "dt-tag",
													"data-tone": "warning",
													children: t("chat.waiting")
												})
											]
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
											className: "dt-msg-text",
											children: message.text
										}),
										message.id === waiting && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
											className: "dt-msg-actions",
											children: [
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Button, {
													variant: "primary",
													size: "sm",
													onClick: () => {
														send(t("chat.agreeText"));
													},
													children: t("chat.agree")
												}),
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Button, {
													variant: "outline",
													size: "sm",
													onClick: () => {
														send(t("chat.refuseText"));
													},
													children: t("chat.refuse")
												}),
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
													type: "button",
													className: "dt-textlink",
													onClick: () => setOpen(true),
													children: t("chat.viewOverview")
												})
											]
										})
									]
								})]
							}, message.id)),
							locals.map((item) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "dt-msg dt-msg-person dt-msg-local",
								"data-testid": "local-submission",
								"data-placement": item.placement,
								"data-state": item.state,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: "dt-msg-bubble",
									children: item.text
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "dt-msg-meta",
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(When, { at: item.at }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: "dt-msg-placement",
										children: placementLabel(t, item)
									})]
								})]
							}, item.id)),
							pending.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "dt-chat-activity",
								"data-testid": "chat-activity",
								role: "status",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "dt-shimmer",
									children: t("chat.activity")
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("chat.queuedCount", { n: String(pending.length) }) })]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", { ref: end })
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(DeskComposer, {
						send,
						busy: pending.length > 0,
						queued: pending.length,
						onVoice: () => setVoice(true)
					})
				]
			});
		}
		//#endregion
		//#region src/client/deployment.tsx
		/**
		* Deployment settings view shared between the panel Settings tab and the DSH Plugin Manager config page.
		* Edits host-level plugin configuration limits through DSH `ConfigForm` when writable.
		*/
		const MACHINE_LIMITS = [
			"promptMaxChars",
			"admissionContextMaxPages",
			"admissionContextTimeoutMs"
		];
		const text = (value) => typeof value === "string" || typeof value === "number" ? String(value) : "";
		const limitsOf = (values) => Object.fromEntries(MACHINE_LIMITS.map((key) => [key, text(values?.[key])]));
		function usePageForm(form) {
			const subscribe = (0, react.useCallback)((listener) => form ? form.subscribe(listener) : () => {}, [form]);
			const state = (0, react.useSyncExternalStore)(subscribe, () => form?.getSnapshot());
			return (0, react.useMemo)(() => form && state ? {
				state,
				mutate: form.mutate.bind(form)
			} : void 0, [form, state]);
		}
		/** Deployment configuration form; falls back to read-only display when DSH config forms are unavailable or read-only. */
		function DeploymentPage({ setup, form, accounts: showAccounts }) {
			const { t, notify } = usePanel();
			const snapshot = form?.state;
			const editable = snapshot?.status === "ready" && snapshot.writable;
			const draft = useDraft({
				saved: limitsOf(editable ? snapshot.value : setup.machine),
				revision: editable ? snapshot.revision : void 0,
				reload: async () => {},
				save: async (value, revision, base) => {
					const ops = MACHINE_LIMITS.filter((key) => value[key].trim() !== base[key].trim()).map((key) => value[key].trim() ? {
						op: "set",
						path: [key],
						value: Number(value[key])
					} : {
						op: "unset",
						path: [key]
					});
					if (!form || !await form.mutate(ops, revision)) throw new Error(t("deploymentRefused"));
					notify(t("saved"));
					return {
						revision: revision + 1,
						restarting: false
					};
				}
			});
			const accounts = setup.accounts;
			const readOnlyHint = !form ? t("deploymentNoForms") : snapshot?.mode === "memory" ? t("deploymentReadOnly") : snapshot?.status === "loading" ? t("loading") : snapshot?.status === "unavailable" ? t("deploymentUnavailable") : !editable ? t("deploymentReadOnly") : void 0;
			const limit = (key, label) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Field, {
				label,
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Input, {
					type: "number",
					min: LIMITS[key].min,
					max: LIMITS[key].max,
					step: 1,
					value: draft.value[key],
					disabled: !editable,
					onChange: (event) => draft.edit({
						...draft.value,
						[key]: event.target.value
					})
				})
			});
			const feishu = accounts?.feishu ? accounts.feishu.name || accounts.feishu.botId : setup.feishuProblem ? setupText(t, setup.feishuProblem) : t("deploymentFeishuNone");
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("form", {
				className: "dt-form",
				onSubmit: (event) => {
					draft.submit(event);
				},
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)(Fields, {
					disabled: draft.busy,
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Hint, { children: t("deploymentIntro") }),
						setup.problem && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "dt-row-buttons",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								className: "dt-error",
								role: "status",
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(SetupMessage, {
									problem: setup.problem,
									lead: true
								})
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(CheckSetupButton, {})]
						}),
						showAccounts && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(Section, {
							title: t("deploymentDerived"),
							hint: t("deploymentDerivedHint"),
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(KeyValues, { rows: [
								[t("deploymentRepository"), accounts?.repository ?? "—"],
								[t("deploymentAgent"), accounts ? `@${accounts.agent}` : "—"],
								[t("deploymentFeishu"), feishu]
							] }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Hint, { children: t("deploymentAccountsWhere") })]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)(Section, {
							title: t("deploymentMachine"),
							children: [readOnlyHint && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Hint, { children: readOnlyHint }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "dt-field",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									className: "dt-field-head",
									children: [t("deploymentStateDir"), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(InfoTip, { text: t("deploymentStateDirHint") })]
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "dt-mono",
									children: setup.machine.stateDir
								})]
							})]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)(Section, {
							title: t("deploymentLimits"),
							hint: t("deploymentLimitsHint"),
							children: [
								limit("promptMaxChars", t("deploymentPromptMaxChars")),
								limit("admissionContextMaxPages", t("deploymentContextPages")),
								limit("admissionContextTimeoutMs", t("deploymentContextTimeout"))
							]
						})
					]
				}), editable && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(SaveBar, {
					...draft,
					onDiscard: draft.discard
				})]
			});
		}
		/** Plugin Manager config page; includes derived repository and accounts because Source settings live in the main panel. */
		function PluginPage({ form }) {
			const { t } = usePanel();
			const { state, error } = usePanelData();
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: "dt-embedded",
				children: state ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(DeploymentPage, {
					setup: state.setup,
					form,
					accounts: true
				}) : error ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
					className: "dt-error",
					role: "alert",
					children: error.message
				}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
					className: "dt-hint",
					children: t("loading")
				})
			});
		}
		/** DSH Plugin Manager config view entry; renders nothing in `summary` mode because DSH displays the package description. */
		function PluginConfig({ t, view, form }) {
			return view === "page" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(PanelProvider, {
				t,
				interval: 1e4,
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(PluginPage, { form })
			}) : null;
		}
		//#endregion
		//#region src/client/prompt-config.ts
		const isSkill = (name) => name.startsWith("skill/");
		/** A built-in part, which the editor names `part/<key>`, apart from the team skills (`skill/<name>`). */
		const isPart = (name) => name.startsWith("part/");
		const partKey = (name) => name.slice(5);
		const sections = (config) => [
			...Object.keys(config).filter((name) => name !== "skills" && name !== "overrides"),
			...Object.keys(config.skills).map((name) => `skill/${name}`),
			...Object.keys(config.overrides ?? {}).map((key) => `part/${key}`)
		];
		/** Returns a team section or team skill's text, a built-in part's override, or `undefined` for one the team did not write. */
		const sectionText = (config, name) => isPart(name) ? config.overrides?.[partKey(name)]?.text : isSkill(name) ? config.skills[name.slice(6)] : name !== "skills" && name !== "overrides" && Object.hasOwn(config, name) ? config[name] : void 0;
		/**
		* A configuration with its overrides, none as an empty map, as the editor keeps it: a draft and the version it moves onto then
		* merge override by override, as a host stores no overrides as none. With `parts`, only the overrides of those parts stay, as
		* a version loaded from the history may override a part this version no longer has.
		*/
		const withOverrides = (config, parts) => ({
			...config,
			overrides: Object.fromEntries(Object.entries(config.overrides ?? {}).filter(([key]) => !parts || parts.some((part) => part.key === key)))
		});
		/** The text a built-in part reads with: the team's override, else its built-in text. */
		const partText = (config, part) => config.overrides?.[part.key]?.text ?? part.text;
		/**
		* Override a built-in part with `text`: an override keeps the built-in text it was edited from, the current one when new or
		* when `rebase`, and goes when its text is the built-in text again.
		*/
		function withOverride(config, part, text, rebase = false) {
			const { [part.key]: previous, ...others } = config.overrides ?? {};
			const base = rebase ? part.base : previous?.base ?? part.base;
			return {
				...config,
				overrides: text === void 0 || text === part.text ? others : {
					...others,
					[part.key]: {
						text,
						base
					}
				}
			};
		}
		function withSection(config, name, text) {
			return isSkill(name) ? {
				...config,
				skills: {
					...config.skills,
					[name.slice(6)]: text
				}
			} : {
				...config,
				[name]: text
			};
		}
		function withoutSkill(config, name) {
			const { [name.slice(6)]: _removed, ...skills } = config.skills;
			return {
				...config,
				skills
			};
		}
		/** The sections, skills and overrides of a draft that differ from the saved version; an override re-based counts too. */
		const changedSections = (config, saved) => [.../* @__PURE__ */ new Set([...sections(config), ...sections(saved)])].filter((name) => isPart(name) ? JSON.stringify(config.overrides?.[partKey(name)]) !== JSON.stringify(saved.overrides?.[partKey(name)]) : sectionText(config, name) !== sectionText(saved, name));
		const sectionLabel = (t, view, name) => isPart(name) ? valueLabel(t, "promptPart", partKey(name)) : isSkill(name) ? `${view.skillPrefix}${name.slice(6)}` : valueLabel(t, "promptPart", name);
		const skillNameFree = (name, config, view) => new RegExp(view.skillName).test(name) && !Object.hasOwn(config.skills, name) && !view.builtin.includes(name);
		/** Formats a team prompt part with its heading (omitted for skills, which have no heading). */
		const partWith = (part, base) => part.heading === void 0 ? base : `${part.heading}\n${base}`;
		/** Compute a line diff, folding runs of more than four unchanged lines to their boundary lines and a count. */
		function lineDiff(before, after) {
			const a = before.split("\n"), b = after.split("\n");
			const lcs = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
			for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
			const lines = [];
			for (let i = 0, j = 0; i < a.length || j < b.length;) if (i < a.length && j < b.length && a[i] === b[j]) {
				lines.push({
					kind: "same",
					text: a[i]
				});
				i++;
				j++;
			} else if (j < b.length && (i === a.length || lcs[i][j + 1] >= lcs[i + 1][j])) lines.push({
				kind: "ins",
				text: b[j++]
			});
			else lines.push({
				kind: "del",
				text: a[i++]
			});
			const folded = [];
			for (let k = 0; k < lines.length;) {
				let end = k;
				while (end < lines.length && lines[end].kind === "same") end++;
				if (end - k > 4) folded.push(lines[k], {
					kind: "fold",
					count: end - k - 2
				}, lines[end - 1]);
				else folded.push(...lines.slice(k, Math.max(end, k + 1)));
				k = Math.max(end, k + 1);
			}
			return folded;
		}
		//#endregion
		//#region src/client/prompts.tsx
		/** Prompts settings group: section/skill editor, full composed prompt preview with diffing, and revision history. */
		const originText = (t, view, from) => from === void 0 ? void 0 : from === "defaults" ? t("promptDraftFromDefaults") : "revision" in from ? t("promptDraftFromHistory", { revision: from.revision }) : t("promptDraftSectionReset", { part: sectionLabel(t, view, from.reset) });
		function PromptsPage() {
			const { call } = usePanel();
			const [view, setView] = (0, react.useState)();
			const [error, setError] = (0, react.useState)();
			const reload = (0, react.useCallback)(async () => {
				setView(await call("GET prompts"));
			}, [call]);
			(0, react.useEffect)(() => {
				reload().catch(setError);
			}, [reload]);
			return view ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(PromptsEditor, {
				view,
				reload
			}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(LoadState, {
				loading: true,
				error
			});
		}
		function PromptsEditor({ view, reload }) {
			const { t, call, notify } = usePanel();
			const saved = withOverrides(view.current.config);
			const draft = useDraft({
				key: `dsh-superagent/prompts/${view.masterId}`,
				saved,
				revision: view.revision,
				reload,
				save: async (config, baseRevision) => {
					const result = await call("PUT prompts", { body: {
						config,
						baseRevision
					} });
					notify(t(result.context_delivery === "pending" ? "promptSavedPending" : "saved"));
					return result;
				}
			});
			const config = draft.value;
			const [tab, setTab] = (0, react.useState)("edit");
			const [selection, select] = (0, react.useState)(draft.meta?.selection ?? "communication");
			const selected = (isPart(selection) ? view.parts.some((part) => part.key === partKey(selection)) : sectionText(config, selection) !== void 0) ? selection : "communication";
			const changed = changedSections(config, saved);
			const edit = (next, note = {}) => draft.edit(next, {
				from: note.from ?? draft.meta?.from,
				selection: note.selection ?? selected
			});
			const open = (name) => {
				select(name);
				setTab("edit");
			};
			const words = {
				merged: (revision) => t("promptConflict", { revision }),
				conflict: (revision, paths) => t("promptConflictParts", {
					revision,
					parts: paths.map(([name, item]) => sectionLabel(t, view, item === void 0 ? name : name === "skills" ? `skill/${item}` : name === "overrides" ? `part/${item}` : name)).join(t("listSeparator"))
				}),
				editing: [
					t("promptsDraftVersion", { revision: draft.revision }),
					t("promptChanges", { count: changed.length }),
					originText(t, view, draft.meta?.from)
				].filter(Boolean).join(" · ")
			};
			const tabs = [
				{
					value: "edit",
					label: t("promptViewEdit")
				},
				{
					value: "full",
					label: t("promptViewFull")
				},
				{
					value: "history",
					label: t("promptViewHistory")
				}
			];
			const removed = view.defaultChanged.filter((item) => item.removed).map((item) => item.part);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "dt-form",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "dt-subtabs",
						role: "tablist",
						"aria-label": t("promptViews"),
						children: tabs.map((item) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							role: "tab",
							className: "dt-subtab",
							"aria-selected": tab === item.value,
							onClick: () => setTab(item.value),
							children: item.label
						}, item.value))
					}),
					removed.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Hint, { children: t("promptRemovedParts", { parts: removed.join(t("listSeparator")) }) }),
					tab === "edit" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(PromptSections, {
						config,
						view,
						changed,
						selected,
						onSelect: select,
						onEdit: edit
					}),
					tab === "full" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(FullPrompt, {
						config,
						view,
						dirty: draft.dirty,
						revision: draft.revision,
						onEdit: open
					}),
					tab === "history" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(PromptHistory, {
						view,
						from: draft.meta?.from,
						onLoad: (next, from) => edit(withOverrides(next, view.parts), { from })
					}, view.revision),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(SaveBar, {
						...draft,
						words,
						onSave: () => {
							draft.submit();
						},
						onDiscard: () => {
							draft.discard();
							reload().catch((failure) => notify(errorText(failure)));
						}
					})
				]
			});
		}
		function PromptSections({ config, view, changed, selected, onSelect, onEdit }) {
			const { t } = usePanel();
			const [name, setName] = (0, react.useState)("");
			const [invalid, setInvalid] = (0, react.useState)(false);
			const item = (section, children) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
				type: "button",
				className: "dt-nav-item",
				"aria-current": section === selected ? "true" : void 0,
				onClick: () => onSelect(section),
				children
			}, section);
			const unsaved = (section) => changed.includes(section) && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				className: "dt-changed-dot",
				"aria-label": t("unsaved")
			});
			const add = (event) => {
				event.preventDefault();
				if (!skillNameFree(name.trim(), config, view)) {
					setInvalid(true);
					return;
				}
				const section = `skill/${name.trim()}`;
				setName("");
				onEdit(withSection(config, section, ""), { selection: section });
				onSelect(section);
			};
			const part = isPart(selected) ? view.parts.find((item) => item.key === partKey(selected)) : void 0;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "dt-prompt",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("nav", {
					className: "dt-prompt-nav",
					"aria-label": t("promptSections"),
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: "dt-nav-group",
							children: t("promptTeamGroup")
						}),
						view.sections.map((section) => item(section, /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: [
							sectionLabel(t, view, section),
							config[section] !== view.defaults[section] && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "dt-changed-tag",
								children: t("promptChanged")
							}),
							unsaved(section)
						] }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("small", { children: t(`promptPartHint.${section}`) })] }))),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: "dt-nav-group",
							children: t("promptBuiltInGroup")
						}),
						view.parts.map((entry) => item(`part/${entry.key}`, /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: [
							sectionLabel(t, view, `part/${entry.key}`),
							config.overrides?.[entry.key] && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "dt-changed-tag",
								children: t("promptChanged")
							}),
							updated(config, entry) && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "dt-changed-tag dt-updated-tag",
								children: t("promptDefaultUpdated")
							}),
							unsaved(`part/${entry.key}`)
						] }))),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: "dt-nav-group",
							children: t("promptSkillsGroup")
						}),
						Object.keys(config.skills).map((skill) => item(`skill/${skill}`, /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: [sectionLabel(t, view, `skill/${skill}`), unsaved(`skill/${skill}`)] }))),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("form", {
							className: "dt-add-skill",
							onSubmit: add,
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Input, {
									value: name,
									placeholder: t("promptSkillName"),
									"aria-label": t("promptAddSkill"),
									spellCheck: false,
									onChange: (event) => {
										setName(event.target.value);
										setInvalid(false);
									}
								}),
								invalid && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									className: "dt-error",
									role: "alert",
									children: t("promptSkillNameInvalid")
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Button, {
									variant: "ghost",
									size: "sm",
									type: "submit",
									icon: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Icon, { name: "plus" }),
									children: t("promptAddSkillAction")
								})
							]
						})
					]
				}), part ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(BuiltInEditor, {
					config,
					view,
					part,
					onEdit
				}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(TeamEditor, {
					config,
					view,
					selected,
					onSelect,
					onEdit
				})]
			});
		}
		/** Whether an override was edited from a built-in text that has changed since. */
		const updated = (config, part) => {
			const override = config.overrides?.[part.key];
			return !!override?.base && override.base !== part.base;
		};
		function TeamEditor({ config, view, selected, onSelect, onEdit }) {
			const { t } = usePanel();
			const text = sectionText(config, selected) ?? "";
			const fallback = sectionText(view.defaults, selected);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "dt-prompt-main",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dt-subhead",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", {
							className: "dt-section-title",
							children: sectionLabel(t, view, selected)
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "dt-actions",
							children: isSkill(selected) ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Button, {
								variant: "outline",
								size: "sm",
								icon: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Icon, { name: "trash" }),
								onClick: () => {
									onEdit(withoutSkill(config, selected), { selection: "communication" });
									onSelect("communication");
								},
								children: t("remove")
							}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Button, {
								variant: "outline",
								size: "sm",
								icon: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Icon, { name: "refresh" }),
								disabled: fallback === text,
								onClick: () => onEdit(withSection(config, selected, fallback ?? ""), { from: { reset: selected } }),
								children: t("promptResetSection")
							})
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Hint, { children: t(isSkill(selected) ? "promptReadBy.skill" : "promptReadBy.both") }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("textarea", {
						className: "dt-textarea dt-mono dt-editor",
						spellCheck: false,
						"aria-label": t("promptBody"),
						value: text,
						onChange: (event) => onEdit(withSection(config, selected, event.target.value))
					})
				]
			});
		}
		/**
		* A built-in part: its text, the team's override or the built-in one, with a reset; a template says which placeholders it
		* keeps; an override whose built-in text changed since shows the change and offers to keep the team's text or take the new one.
		*/
		function BuiltInEditor({ config, view, part, onEdit }) {
			const { t } = usePanel();
			const name = `part/${part.key}`;
			const reset = () => onEdit(withOverride(config, part, void 0), { from: { reset: name } });
			const base = config.overrides?.[part.key]?.base;
			const previous = view.defaultChanged.find((item) => item.part === part.key && item.base === base)?.previous;
			const readBy = part.key.startsWith("skill/") ? "promptReadBy.skill" : part.roles.length > 1 ? "promptReadBy.both" : `promptReadBy.${part.roles[0]}`;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "dt-prompt-main",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dt-subhead",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", {
							className: "dt-section-title",
							children: sectionLabel(t, view, name)
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "dt-actions",
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Button, {
								variant: "outline",
								size: "sm",
								icon: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Icon, { name: "refresh" }),
								disabled: !config.overrides?.[part.key],
								onClick: reset,
								children: t("promptResetSection")
							})
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Hint, { children: t(readBy) }),
					part.placeholders && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Hint, { children: t("promptTemplateHint", { placeholders: part.placeholders.join(t("listSeparator")) }) }),
					updated(config, part) && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
						className: "dt-default-updated",
						"aria-label": t("promptDefaultUpdated"),
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("b", { children: t("promptDefaultUpdated") }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Hint, { children: t("promptDefaultUpdatedHint") }),
							previous !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Hint, { children: t("promptDefaultUpdatedKnown") }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Diff, { lines: lineDiff(previous, part.text) })] }) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Hint, { children: t("promptDefaultUpdatedUnknown") }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Diff, { lines: lineDiff(partText(config, part), part.text) })] }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								className: "dt-actions",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Button, {
									variant: "outline",
									size: "sm",
									onClick: () => onEdit(withOverride(config, part, partText(config, part), true)),
									children: t("promptKeepMine")
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Button, {
									variant: "outline",
									size: "sm",
									onClick: reset,
									children: t("promptTakeDefault")
								})]
							})
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("textarea", {
						className: "dt-textarea dt-mono dt-editor",
						spellCheck: false,
						"aria-label": t("promptBody"),
						value: partText(config, part),
						onChange: (event) => onEdit(withOverride(config, part, event.target.value))
					})
				]
			});
		}
		const KIND_LABEL = {
			team: "promptPartTeam",
			fixed: "promptPartFixed",
			generated: "promptPartGenerated"
		};
		function FullPrompt({ config, view, dirty, revision, onEdit }) {
			const { t, call, notify } = usePanel();
			const [target, setTarget] = (0, react.useState)("orchestrator");
			const [compare, setCompare] = (0, react.useState)(dirty ? "saved" : "default");
			const [preview, setPreview] = (0, react.useState)();
			const [error, setError] = (0, react.useState)();
			(0, react.useEffect)(() => {
				let active = true;
				call("POST prompts/preview", { body: config }).then((value) => {
					if (active) {
						setPreview({
							config,
							value
						});
						setError(void 0);
					}
				}, (failure) => {
					if (active) setError(failure);
				});
				return () => {
					active = false;
				};
			}, [call, config]);
			if (!preview || error) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(LoadState, {
				loading: true,
				error
			});
			const shown = dirty ? compare : "default";
			const team = isSkill(target) && Object.hasOwn(preview.config.skills, target.slice(6));
			const parts = isSkill(target) ? [{
				name: target,
				kind: team ? "team" : "fixed",
				...team ? {} : { key: target },
				text: preview.value.skills[target.slice(6)] ?? ""
			}] : preview.value.parts[target];
			const builtIn = (key) => view.parts.find((part) => part.key === key);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "dt-subhead",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
						className: "dt-select dt-inline-select",
						"aria-label": t("promptPreviewTarget"),
						value: target,
						onChange: (event) => setTarget(event.target.value),
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
								value: "orchestrator",
								children: valueLabel(t, "promptRole", "orchestrator")
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
								value: "worker",
								children: valueLabel(t, "promptRole", "worker")
							}),
							Object.keys(preview.value.skills).map((name) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
								value: `skill/${name}`,
								children: sectionLabel(t, view, `skill/${name}`)
							}, name))
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Hint, { children: t("promptFullState", {
						count: parts.length,
						chars: parts.reduce((sum, part) => sum + part.text.length, 0),
						state: dirty ? t("promptPreviewDraft") : t("promptPreviewSaved", { revision })
					}) }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(SegmentedControl, {
						className: "dt-segmented dt-compare",
						label: t("promptCompare"),
						value: shown,
						options: [...dirty ? [{
							value: "saved",
							label: t("promptCompareSaved")
						}] : [], {
							value: "default",
							label: t("promptCompareDefault")
						}],
						onChange: setCompare
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Button, {
						variant: "outline",
						size: "sm",
						icon: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Icon, { name: "copy" }),
						onClick: () => {
							navigator.clipboard.writeText(parts.map((part) => part.text).join("\n\n")).then(() => notify(t("copied")));
						},
						children: t("promptCopyAll")
					})
				]
			}), parts.map((part) => {
				const { kind } = part;
				const text = sectionText(preview.config, part.name) ?? "";
				const entry = part.key === void 0 ? void 0 : builtIn(part.key);
				const from = (config) => kind === "team" ? partWith(part, sectionText(config, part.name) ?? "") : kind === "fixed" && entry ? partText(config, entry) : void 0;
				const base = from(shown === "saved" ? view.current.config : view.defaults);
				const edited = kind === "team" ? !isSkill(part.name) && text !== sectionText(view.defaults, part.name) : !!entry && !!preview.config.overrides?.[entry.key];
				const template = kind === "generated" && !!entry && preview.config.overrides?.[entry.key]?.text !== view.current.config.overrides?.[entry.key]?.text;
				return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
					className: "dt-preview-part",
					"data-editable": kind === "team" || entry !== void 0 || void 0,
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dt-preview-head",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("b", { children: sectionLabel(t, view, entry ? `part/${entry.key}` : part.name) }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t(KIND_LABEL[kind]) }),
							edited && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "dt-changed-tag",
								children: t("promptChanged")
							}),
							(kind === "team" || entry) && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: "dt-textlink",
								onClick: () => onEdit(entry ? `part/${entry.key}` : part.name),
								children: t("promptEditSource")
							})
						]
					}), base !== void 0 && base !== part.text ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Diff, { lines: lineDiff(base, part.text) }) : shown === "saved" && !template ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Hint, { children: t(kind === "generated" ? "promptBuiltInFolded" : "promptSameAsSaved") }) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("pre", {
						className: "dt-pre",
						children: part.text
					})]
				}, part.name);
			})] });
		}
		function Diff({ lines }) {
			const { t } = usePanel();
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("pre", {
				className: "dt-pre",
				children: lines.map((line, index) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(react.Fragment, { children: line.kind === "fold" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: "dt-diff-fold",
					children: t("promptSameLines", { count: line.count })
				}), "\n"] }) : line.kind === "ins" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("ins", { children: `${line.text}\n` }) : line.kind === "del" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("del", { children: `${line.text}\n` }) : `${line.text}\n` }, index))
			});
		}
		function PromptHistory({ view, from, onLoad }) {
			const { t, call } = usePanel();
			const [older, setOlder] = (0, react.useState)();
			const next = older ? older.next_offset : view.next_offset;
			const more = useAction(async (offset) => {
				const page = await call("GET prompts", { query: { offset } });
				setOlder({
					revisions: [...older?.revisions ?? [], ...page.revisions],
					next_offset: page.next_offset
				});
			});
			const load = useAction(async (revision) => {
				onLoad((await call("GET prompts", { query: { revision } })).current.config, { revision });
			});
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "dt-form",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Hint, { children: t("promptHistoryHint") }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("ul", {
						className: "dt-list",
						children: [...view.revisions, ...older?.revisions ?? []].map((version) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", {
							className: "dt-row",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "dt-row-main",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: "dt-row-title",
									children: t("promptHistoryItem", {
										revision: version.revision,
										time: version.savedAt ? when(version.savedAt, t("lang")) : t("promptHistoryInitial"),
										source: valueLabel(t, "historySource", version.source)
									})
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: "dt-row-meta",
									children: version.changed.length ? t("promptHistoryChanged", { parts: version.changed.map((name) => sectionLabel(t, view, name)).join(t("listSeparator")) }) : t("promptHistoryNone")
								})]
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "dt-row-actions",
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Button, {
									variant: "outline",
									size: "sm",
									icon: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Icon, { name: "history" }),
									disabled: load.busy || typeof from === "object" && "revision" in from && from.revision === version.revision,
									onClick: () => {
										load.run(version.revision);
									},
									children: t("promptRestore")
								})
							})]
						}, version.revision))
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dt-actions",
						children: [next !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Button, {
							variant: "outline",
							size: "sm",
							icon: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Icon, { name: "chevron-down" }),
							disabled: more.busy,
							onClick: () => {
								more.run(next);
							},
							children: t("promptOlder")
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Button, {
							variant: "outline",
							size: "sm",
							icon: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Icon, { name: "refresh" }),
							onClick: () => onLoad(view.defaults, "defaults"),
							children: t("promptDefaults")
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dt-field",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("promptSessions") }), view.sessions.length ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("ul", {
							className: "dt-changes dt-mono",
							children: view.sessions.map((item) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("li", { children: t("promptSessionItem", {
								session: item.sessionId,
								revision: item.revision
							}) }, item.sessionId))
						}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Hint, { children: t("promptNoSessions") })]
					})
				]
			});
		}
		//#endregion
		//#region src/client/settings.tsx
		const STAGE_GROUPS = [
			"source",
			"eval",
			"execution"
		];
		function SettingsPage({ group, query, state, deploymentForm }) {
			const { t, navigate } = usePanel();
			const content = (() => {
				switch (group) {
					case "source": return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(SettingsProvider, { children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(SourceSettings, { ...query.source ? { focus: query.source } : {} }) });
					case "eval": return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(SettingsProvider, { children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(EvalSettings, { version: query.version }) });
					case "execution": return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(SettingsProvider, { children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ExecutionSettings, {}) });
					case "prompts": return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(PromptsPage, {});
					case "deployment": return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(DeploymentPage, {
						setup: state.setup,
						form: deploymentForm
					});
				}
			})();
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "dt-settings",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("nav", {
					className: "dt-settings-nav",
					"aria-label": t("tab.settings"),
					children: SETTINGS_GROUPS.map((value) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						className: "dt-settings-link",
						"data-stage": STAGE_GROUPS.includes(value) || void 0,
						"aria-current": value === group ? "page" : void 0,
						onClick: () => navigate(settingsRoute(value), true),
						children: t(`settingsGroup.${value}`)
					}, value))
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "dt-settings-body",
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h2", {
						className: "dt-settings-title",
						children: t(`settingsGroup.${group}`)
					}), content]
				})]
			});
		}
		//#endregion
		//#region src/client/thread.tsx
		/** Thread detail page: Trigger timeline with gap-free pagination, Decisions, subscribed Tickets, and correlated Threads. */
		/** Disposition tags for a Trigger; omits `ignore` (the common case) and suppresses fanout tags when every target Ticket is already listed in `subscribed`. */
		function triggerTags(t, trigger, subscribed) {
			const d = trigger.disposition;
			const tags = [];
			if (d.queued) tags.push(/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Tag, {
				tone: "info",
				children: t("dispositionQueued")
			}, "q"));
			else if (d.evaluating) tags.push(/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Tag, {
				tone: "info",
				children: t("dispositionEvaluating")
			}, "e"));
			else if (d.filtered) tags.push(/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Tag, {
				tone: "neutral",
				children: t("tagFiltered", { reason: reasonLabel(t, d.filtered) })
			}, "f"));
			else if (d.decision && d.decision.outcome !== "ignore") {
				const { tone, label } = decisionMark(t, d.decision.outcome);
				tags.push(/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Tag, {
					tone,
					children: label
				}, "d"));
			}
			if (d.delivered) tags.push(/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Tag, {
				tone: "info",
				title: t("dispositionDeliveredHint"),
				children: t("dispositionDelivered")
			}, "o"));
			else if (d.fanout.length && !(subscribed && d.fanout.every((id) => subscribed.has(id)))) tags.push(/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Tag, {
				tone: "info",
				children: t("dispositionFanout", { count: d.fanout.length })
			}, "o"));
			return tags;
		}
		function TriggerItem({ trigger, earlier, target, subscribed, requeue }) {
			const { t, navigate } = usePanel();
			const ticketId = trigger.disposition.decision?.ticketId;
			const scroll = (element) => {
				if (element && target === trigger.id && !element.dataset.scrolled) {
					element.dataset.scrolled = "1";
					element.scrollIntoView?.({ block: "center" });
				}
			};
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", {
				id: `trigger-${trigger.id}`,
				className: `dt-event${target === trigger.id ? " dt-highlight" : ""}${trigger.human ? "" : " dt-event-quiet"}`,
				ref: scroll,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dt-event-foot",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", {
							className: "dt-event-actor",
							children: actorName(t, trigger.actor)
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(When, { at: trigger.at })]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(ClampText, { text: readableMarkers(t, trigger.text || trigger.preview) }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Earlier, { items: earlier }),
					trigger.disposition.handbacks.map((item) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Hint, { children: t("handedBack", {
						ticket: item.title,
						reason: item.reason
					}) }, item.ticketId)),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dt-event-foot",
						children: [
							triggerTags(t, trigger, subscribed),
							ticketId && !subscribed.has(ticketId) && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: "dt-textlink dt-icon-link",
								onClick: () => navigate({
									page: "execution",
									id: ticketId
								}),
								children: t("openTicket")
							}),
							requeue && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
								type: "button",
								className: "dt-textlink dt-icon-link dt-reveal",
								disabled: requeue.busy,
								"aria-busy": requeue.busy,
								onClick: requeue.run,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Icon, {
									name: "refresh",
									size: 13
								}), t("requeue")]
							})
						]
					})
				]
			});
		}
		const overlaps = (some, others) => some.some((item) => others.some((other) => other.id === item.id));
		const byTime = (triggers) => [...new Map(triggers.map((item) => [item.id, item])).values()].sort((a, b) => a.at.localeCompare(b.at));
		const gapBetween = (newest, older) => !!older && newest.earlier !== null && !overlaps(newest.timeline, older.triggers);
		function mergeTimeline(newest, older) {
			if (!older || newest.earlier === null || gapBetween(newest, older)) return newest;
			return {
				...newest,
				timeline: byTime([...older.triggers, ...newest.timeline]),
				earlier: older.cursor
			};
		}
		const PAGE = 50;
		/**
		* Manage a Thread's timeline across live polling, deep-linked `target` Triggers, and manual pagination.
		* Fills any gap between the latest polled page and older loaded pages before merging so the timeline remains contiguous.
		*/
		function useThreadTimeline(key, target) {
			const { call, notify } = usePanel();
			const [older, setOlder] = (0, react.useState)();
			const { data: newest, error, reload } = usePoll(() => call("GET threads/:key", {
				key,
				query: { limit: PAGE }
			}), [key]);
			const data = newest && mergeTimeline(newest, older);
			const read = (id) => !!newest?.timeline.some((item) => item.id === id) || !!older?.triggers.some((item) => item.id === id);
			const missing = !!target && !!newest && !read(target);
			(0, react.useEffect)(() => {
				if (!missing) return;
				let active = true;
				call("GET threads/:key", {
					key,
					query: {
						limit: PAGE,
						around: target
					}
				}).then((page) => {
					if (active) setOlder({
						triggers: page.timeline,
						cursor: page.earlier
					});
				}, (failure) => {
					if (active) notify(errorText(failure));
				});
				return () => {
					active = false;
				};
			}, [
				missing,
				call,
				key,
				target,
				notify
			]);
			const gap = !!newest && gapBetween(newest, older);
			(0, react.useEffect)(() => {
				if (!gap || !newest || !older) return;
				let active = true;
				const fill = async () => {
					let run = newest.timeline, cursor = newest.earlier;
					while (cursor !== null && !overlaps(run, older.triggers)) {
						const page = await call("GET threads/:key", {
							key,
							query: {
								limit: PAGE,
								before: cursor
							}
						});
						run = [...page.timeline, ...run];
						cursor = page.earlier;
					}
					if (active) setOlder({
						triggers: byTime([...older.triggers, ...run]),
						cursor: overlaps(run, older.triggers) ? older.cursor : cursor
					});
				};
				fill().catch((failure) => {
					if (active) notify(errorText(failure));
				});
				return () => {
					active = false;
				};
			}, [
				gap,
				newest,
				older,
				call,
				key,
				notify
			]);
			return {
				data,
				error,
				reload,
				earlier: useAction(async (shown) => {
					const page = await call("GET threads/:key", {
						key,
						query: {
							limit: PAGE,
							before: shown.earlier
						}
					});
					setOlder({
						triggers: [...page.timeline, ...shown.timeline],
						cursor: page.earlier
					});
				})
			};
		}
		function ThreadPage({ id, target }) {
			const { t, call, navigate, notify } = usePanel();
			const [decisionsOpen, setDecisionsOpen] = (0, react.useState)(false);
			const { data, error, reload, earlier } = useThreadTimeline(id, target);
			const requeue = useAction(async (trigger) => {
				if (!(await call("POST triggers/:id/requeue", { id: trigger })).queued) notify(t("requeueAlready"));
			}, { reload });
			if (!data) return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(PageHead, { title: t("term.thread") }), error instanceof ApiError && error.missing ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Hint, { children: t("threadNotFound") }) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(LoadState, {
				error,
				loading: true
			})] });
			const subscribed = new Set(data.tickets.map((ticket) => ticket.id));
			const sender = (trigger) => !trigger.human && trigger.id !== target ? `${trigger.actor.source}:${trigger.actor.id}` : void 0;
			const unsubscribe = async () => {
				if ((await call("POST threads/:key/unsubscribe", { key: data.key })).context_delivery === "pending") notify(t("unsubscribePending"));
				await reload();
			};
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)(PageHead, {
					title: readableMarkers(t, data.title),
					children: data.url && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ActionLink, {
						href: data.url,
						children: t("openOriginal")
					})
				}),
				error && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(LoadState, {
					error,
					loading: false
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "dt-row-meta dt-status-line",
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: valueLabel(t, "source", data.source) }),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("threadLatest", { time: when(data.lastAt, t("lang")) }) }),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("threadCreated", { time: when(data.createdAt, t("lang")) }) })
					]
				}),
				data.evaluating && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
					className: "dt-banner",
					children: t("evaluatingBanner", {
						count: data.evaluating.triggers,
						strength: valueLabel(t, "strength", data.evaluating.strength),
						deadline: when(data.evaluating.deadline, t("lang"))
					})
				}),
				data.pollError && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
					className: "dt-error dt-clamp",
					children: t("pollFailed", { error: data.pollError })
				}),
				data.tickets.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Section, {
					title: t("subscribedTickets"),
					count: data.tickets.length,
					children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("ul", {
						className: "dt-list",
						children: data.tickets.map((ticket) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(TicketLine, {
							ticket,
							context: data.context.includes(ticket.id)
						}, ticket.id))
					})
				}),
				data.decisions.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(DisclosureRow, {
					icon: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Icon, { name: "decision" }),
					title: t("threadDecisions", { count: data.decisions.length }),
					open: decisionsOpen,
					onToggle: () => setDecisionsOpen(!decisionsOpen),
					children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "dt-disclosure-body",
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("ul", {
							className: "dt-list",
							children: data.decisions.map((decision) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(DecisionLine, { decision }, decision.id))
						})
					})
				}),
				data.correlated.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Section, {
					title: t("term.correlation"),
					children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("ul", {
						className: "dt-plain-list",
						children: data.correlated.map((item) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("li", { children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: "dt-textlink",
							onClick: () => navigate({
								page: "trigger",
								id: item.key
							}),
							children: readableMarkers(t, item.title)
						}) }, item.key))
					})
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsxs)(Section, {
					title: t("timeline"),
					count: t("newestFirst"),
					children: [data.timeline.length ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("ol", {
						className: "dt-timeline",
						children: automatedRuns(data.timeline.slice().reverse(), sender).map(({ item, earlier: folded }) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(TriggerItem, {
							trigger: item,
							earlier: folded,
							target,
							subscribed,
							requeue: item.actions.requeue ? {
								busy: requeue.busy,
								run: () => {
									requeue.run(item.id);
								}
							} : void 0
						}, item.id))
					}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Hint, { children: t("noTriggers") }), data.earlier && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", { children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Button, {
						variant: "outline",
						size: "sm",
						icon: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Icon, {
							name: "chevron-down",
							size: 14
						}),
						disabled: earlier.busy,
						onClick: () => {
							earlier.run(data);
						},
						children: t("loadEarlier")
					}) })]
				}),
				data.tickets.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "dt-danger-zone",
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "dt-hint",
						children: t("unsubscribeHint")
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ConfirmButton, {
						variant: "outline",
						icon: "unsubscribe",
						label: t("unsubscribe"),
						title: t("unsubscribeTitle"),
						message: t("unsubscribeConfirm", { title: data.title }),
						onConfirm: unsubscribe
					})]
				})
			] });
		}
		//#endregion
		//#region src/client/ticket.tsx
		/** Ticket detail page: stage and actions, Mandate details, undelivered/delivered Inputs, subscribed Threads, and Assignments. */
		function InputLine({ input, earlier = [] }) {
			const { t, navigate } = usePanel();
			const trigger = input.kind === "trigger" ? input.trigger : void 0;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", {
				className: "dt-row",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Dot, {
					state: input.delivered ? "idle" : "warning",
					label: input.delivered ? t("inputDelivered") : t("inputUndelivered")
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "dt-row-main",
					children: [
						trigger ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: "dt-row-title",
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
								type: "button",
								className: "dt-open",
								onClick: () => navigate({
									page: "trigger",
									id: trigger.thread,
									query: { trigger: trigger.id }
								}),
								children: [
									actorName(t, trigger.actor),
									t("labelSeparator"),
									readableMarkers(t, trigger.preview) || t("empty")
								]
							})
						}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: "dt-row-title",
							children: valueLabel(t, "input", input.kind)
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "dt-row-meta",
							children: [input.kind === "trigger" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: valueLabel(t, "input", input.kind) }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(When, { at: input.at })]
						}),
						(input.kind === "text" || input.kind === "note") && input.text && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: "dt-row-quote",
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(MarkdownLite, { text: input.text })
						}),
						trigger?.handback && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Hint, { children: t("inputHandedBack", { reason: trigger.handback.reason }) }),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Earlier, { items: earlier })
					]
				})]
			});
		}
		function InputList({ inputs }) {
			const sender = (input) => input.kind === "trigger" && input.trigger && !input.trigger.human ? `${input.trigger.actor.source}:${input.trigger.actor.id}` : void 0;
			const shown = (input) => ({
				id: input.id,
				at: input.at,
				preview: input.kind === "trigger" ? input.trigger?.preview ?? "" : ""
			});
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("ul", {
				className: "dt-list",
				children: automatedRuns(inputs, sender).map((run) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(InputLine, {
					input: run.item,
					earlier: run.earlier.map(shown)
				}, run.item.id))
			});
		}
		function Details({ icon, title, open = false, children }) {
			const [shown, setShown] = (0, react.useState)(open);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(DisclosureRow, {
				icon: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Icon, { name: icon }),
				title,
				open: shown,
				onToggle: () => setShown(!shown),
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					className: "dt-disclosure-body",
					children
				})
			});
		}
		function Assignments({ ticket }) {
			const { t } = usePanel();
			const report = (state) => t("assignmentReportShort", { state: valueLabel(t, "report", state) });
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("ul", {
				className: "dt-list",
				children: ticket.assignments.slice().reverse().map((item, index) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", {
					className: "dt-row",
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Dot, {
							state: item.state === "running" ? reportDot(item.report?.state) : "idle",
							label: valueLabel(t, "assignment", item.state)
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "dt-row-main",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "dt-row-title",
								children: t("assignmentNumber", { number: ticket.assignments.length - index })
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "dt-row-meta",
								children: [
									item.turnEndedAt && item.report ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Tag, {
										tone: "neutral",
										children: report(item.report.state)
									}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Tag, {
										tone: item.state === "running" ? "info" : "neutral",
										children: valueLabel(t, "assignment", item.state)
									}),
									item.state !== "running" && item.report && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: report(item.report.state) }),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("assignmentSpan", {
										from: when(item.startedAt ?? item.createdAt, t("lang")),
										to: when(item.endedAt ?? item.turnEndedAt, t("lang")) || t("now")
									}) }),
									item.endedReason && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: reasonLabel(t, item.endedReason) })
								]
							})]
						}),
						item.ref && item.ref !== ticket.sessionId && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: "dt-row-actions",
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(SessionButton, {
								variant: "outline",
								sessionId: item.ref
							})
						})
					]
				}, item.id))
			});
		}
		function MandateDetails({ ticket, actor }) {
			const { t, navigate } = usePanel();
			const { mandate, decision } = ticket;
			const fact = (item) => {
				if (item.name === "legacyAuthority") return valueLabel(t, "legacy", item.value);
				if (item.name === "mode" || item.name === "addressed") return valueLabel(t, item.name, item.value);
				if (item.name === "admission") return valueLabel(t, "admissionCell", item.value);
				if (item.name === "rules") return item.value.map((rule) => rule.name).join(t("listSeparator"));
				return item.name === "sender" ? item.value : t("yes");
			};
			const { legacy } = ticket.basis;
			const facts = ticket.basis.facts.filter((item) => !(item.name === "sender" && item.value === actor));
			const direction = decision?.direction;
			const rows = decision ? [[t("term.trigger"), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
				type: "button",
				className: "dt-trigger-link",
				onClick: () => navigate({
					page: "trigger",
					id: decision.thread,
					query: { trigger: decision.triggerIds[0] ?? "" }
				}),
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: "dt-trigger-text",
					children: readableMarkers(t, decision.preview) || t("empty")
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
					className: "dt-row-meta",
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: [
						valueLabel(t, "source", mandate.actor.source),
						" · ",
						actor
					] }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(When, { at: decision.at })]
				})]
			})], [t("term.decision"), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "dt-kv-stack",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: decisionMark(t, decision.outcome).label }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Hint, { children: reasonLabel(t, decision.reason) }),
					decision.rules.map((rule) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Hint, { children: t(rule.matched ? "ruleMatched" : "ruleUnmatched", {
						rule: rule.name,
						reason: rule.reason
					}) }, rule.id)),
					direction && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(Hint, { children: [
						t("directionLine", {
							intent: t(direction.implementation_requested ? "intentYes" : "intentNo"),
							basis: valueLabel(t, "targetBasis", direction.target_basis),
							design: t(direction.requires_design_decision ? "designNeeded" : "designNotNeeded")
						}),
						" ",
						t("directionEvidence", { evidence: direction.evidence })
					] })
				]
			})]] : [];
			const version = /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
				type: "button",
				className: "dt-textlink dt-mono",
				onClick: () => navigate(settingsRoute("eval", { version: mandate.policyVersion })),
				children: mandate.policyVersion.slice(0, 8)
			});
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Section, {
				title: t("mandateDetails"),
				icon: "shield",
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(KeyValues, { rows: [
					...rows,
					[t("term.scope"), legacy ? t("legacyScopeShort") : mandate.scope || t("empty")],
					...facts.map((item) => [valueLabel(t, "basis", item.name), fact(item)]),
					...legacy ? [] : [[t("policyVersion"), version]]
				] })
			});
		}
		function TicketPage({ id }) {
			const { t, call, navigate } = usePanel();
			const { data, error, reload } = usePoll(() => call("GET tickets/:id", { id }), [id]);
			const after = async (request) => {
				await request;
				await reload();
			};
			if (!data) return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(PageHead, { title: t("term.ticket") }), error instanceof ApiError && error.missing ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Hint, { children: t("ticketNotFound") }) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(LoadState, {
				error,
				loading: true
			})] });
			const status = ticketMark(t, data);
			const actor = actorName(t, data.mandate.actor);
			const { legacy } = data.basis;
			const undelivered = data.inputs.filter((input) => !input.delivered);
			const failedText = /^(?:\w+Error|Error)\b[:：]/.test(data.summary);
			const failed = data.stage === "person" && data.action === "failed";
			const opening = data.threads.find((thread) => thread.url);
			const ended = data.ended && (() => {
				const outcome = valueLabel(t, "outcome", data.ended.outcome), reason = reasonLabel(t, data.ended.reason), time = when(data.ended.at, t("lang"));
				return reason ? t("endedAt", {
					time,
					outcome,
					reason
				}) : t("endedAtShort", {
					time,
					outcome
				});
			})();
			const channel = data.channels[0];
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
				/* @__PURE__ */ (0, react_jsx_runtime.jsxs)(PageHead, {
					title: data.title,
					children: [
						opening?.url && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ActionLink, {
							href: opening.url,
							children: t("openThread", { source: valueLabel(t, "source", opening.source) })
						}),
						data.actions.retry && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ConfirmButton, {
							variant: "outline",
							icon: "refresh",
							label: t("retry"),
							title: t("retryTitle"),
							message: t("retryConfirm", { title: data.title }),
							onConfirm: () => after(call("POST tickets/:id/retry", { id }))
						}),
						data.sessionId && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(SessionButton, {
							variant: "outline",
							sessionId: data.sessionId
						})
					]
				}),
				error && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(LoadState, {
					error,
					loading: false
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "dt-row-meta dt-status-line",
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(StageMark, {
							state: status.dot,
							icon: status.icon,
							label: status.label
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(LabelValue, {
							label: t("ticketMandateLabel"),
							value: valueLabel(t, "strength", data.mandate.strength)
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(LabelValue, {
							label: t("ticketActorLabel"),
							value: `${valueLabel(t, "source", data.mandate.actor.source)} · ${actor}`
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(LabelValue, {
							label: t("ticketUpdatedLabel"),
							value: when(data.updatedAt, t("lang"))
						}),
						data.group && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							"data-testid": "ticket-group",
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(LabelValue, {
								label: t("ticketGroupLabel"),
								value: data.group.roomName
							})
						}),
						data.relays.resent + data.relays.side > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							"data-testid": "ticket-relays",
							title: data.relays.sessions.map((item) => `${item.step ?? t("usageRole.worker")}: ${t("usageRelaySession", {
								resent: String(item.resent),
								side: String(item.side)
							})}`).join("\n"),
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(LabelValue, {
								label: t(data.coexist.dsBot ? "ticketRelaysDsBot" : "ticketRelaysOther"),
								value: t("usageRelaySession", {
									resent: String(data.relays.resent),
									side: String(data.relays.side)
								})
							})
						})
					]
				}),
				ended && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Hint, { children: ended }),
				data.attention && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "dt-banner",
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "dt-banner-label",
							children: t("attentionPrefix")
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(MarkdownLite, { text: data.attention.question }),
						channel && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: "dt-banner-actions",
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ActionLink, {
								href: channel.url,
								icon: "message",
								onActivate: () => navigate({ page: "chat" }),
								children: t("answerIn", { source: valueLabel(t, "source", channel.source) })
							})
						})
					]
				}),
				data.actions.retry && data.summary && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
					className: `dt-banner${failed ? " dt-danger" : ""}${failedText ? " dt-mono" : ""}`,
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "dt-banner-label",
						children: t(failed ? "failedPrefix" : "blockedPrefix")
					}), data.summary]
				}),
				data.deliveryError && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
					className: "dt-banner dt-danger dt-mono",
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "dt-banner-label",
						children: t("deliveryFailedPrefix")
					}), data.deliveryError]
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)(MandateDetails, {
					ticket: data,
					actor
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)(ReviewSection, {
					id,
					onChanged: reload
				}),
				undelivered.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(Section, {
					title: t("undeliveredInputs"),
					count: undelivered.length,
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Hint, { children: data.deliveryError ? t("inputRetryHint") : data.paused ? t("inputPausedHint") : t("inputWaitingHint") }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(InputList, { inputs: undelivered })]
				}),
				data.threads.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Section, {
					title: t("subscribedThreads"),
					count: data.threads.length,
					children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("ul", {
						className: "dt-list",
						children: data.threads.map((thread) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ThreadLine, {
							thread,
							ticketId: data.id,
							context: thread.context
						}, thread.key))
					})
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "dt-details",
					children: [
						data.assignments.length > 1 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Details, {
							icon: "queue",
							title: `${t("term.assignment")} · ${data.assignments.length}`,
							open: true,
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Assignments, { ticket: data })
						}),
						data.environment.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Details, {
							icon: "settings",
							title: t("term.environment"),
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("table", {
								className: "dt-table",
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("tbody", { children: data.environment.map((variable) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("tr", {
									title: localized(t, variable.description),
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
										className: "dt-mono",
										children: variable.key
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
										className: "dt-mono",
										children: variable.value || /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: "dt-hint",
											children: t("empty")
										})
									})]
								}, variable.key)) })
							})
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Details, {
							icon: "message",
							title: t("term.channel"),
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("ul", {
								className: "dt-plain-list",
								children: data.channels.map((item, index) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("li", { children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ExternalLink, {
									href: item.url,
									icon: item.source === "github" ? "pull" : "message",
									children: localized(t, item.label)
								}) }, index))
							})
						}),
						data.inputs.length > undelivered.length && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Details, {
							icon: "inbox",
							title: t("deliveredInputs", { count: data.inputs.length - undelivered.length }),
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(InputList, { inputs: data.inputs.filter((input) => input.delivered) })
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Details, {
							icon: "hash",
							title: t("identifiers"),
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(KeyValues, { rows: [
								[t("ticketId"), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "dt-mono",
									children: data.id
								})],
								[t("executionDirectory"), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "dt-mono",
									children: data.directory ?? t("empty")
								})],
								...legacy && data.mandate.scope ? [[t("legacyAssignment"), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "dt-mono dt-clamp",
									children: data.mandate.scope
								})]] : []
							] })
						})
					]
				}),
				data.actions.stop && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "dt-danger-zone",
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "dt-hint",
						children: t("stopHint")
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ConfirmButton, {
						variant: "outline",
						label: t("stop"),
						title: t("stopConfirmTitle"),
						message: t("stopConfirm", { title: data.title }),
						onConfirm: () => after(call("POST tickets/:id/stop", { id }))
					})]
				})
			] });
		}
		//#endregion
		//#region src/client/trigger.tsx
		/** Trigger status view listing Threads filtered by subscription and evaluation activity. */
		function TriggerStatus({ filter }) {
			const { t, call, navigate } = usePanel();
			const [limit, setLimit] = (0, react.useState)(20);
			const { data, error } = usePoll(() => call("GET threads", { query: {
				filter,
				limit
			} }), [filter, limit]);
			const go = (next) => {
				setLimit(20);
				navigate({
					page: "trigger",
					query: next !== "subscribed" ? { filter: next } : {}
				}, true);
			};
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)(StatusHead, { hint: t("triggerIntro") }),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					className: "dt-filters",
					children: THREAD_FILTERS.map((value) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Pill, {
						active: filter === value,
						onClick: () => go(value),
						children: t(`threadFilter.${value}`)
					}, value))
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)(LoadState, {
					error,
					loading: !data
				}),
				data && (data.items.length ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("ul", {
					className: "dt-list",
					children: data.items.map((thread) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ThreadLine, { thread }, thread.key))
				}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Hint, { children: t("threadsNone") })),
				data?.next_offset != null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(LoadMore, { onMore: () => setLimit(limit + 20) })
			] });
		}
		//#endregion
		//#region src/client/app.tsx
		/**
		* Root panel shell: header with global search and glossary, top-level navigation tabs, and active route view.
		* VsSaros change: the first tab is the supervisor desk's Chat, and the Overview lives in a side panel beside the page.
		*/
		function Glossary({ open, onClose }) {
			const { t } = usePanel();
			const chinese = t("tab.overview") === zh["tab.overview"];
			const [own, other] = chinese ? [zh, en] : [en, zh];
			const heading = (group) => t(group === "roles" ? "glossaryGroup.roles" : `tab.${group}`);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Modal, {
				className: "dt-glossary-modal",
				open,
				onClose,
				title: t("glossary"),
				closeLabel: t("close"),
				description: t("glossaryIntro"),
				footer: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Button, {
					variant: "primary",
					onClick: onClose,
					children: t("close")
				}),
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "dt-glossary-body",
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("table", {
							className: "dt-glossary",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("thead", { children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("tr", { children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", { children: t(chinese ? "glossaryChinese" : "glossaryEnglish") }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", { children: t(chinese ? "glossaryEnglish" : "glossaryChinese") }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", { children: t("glossaryMeaning") })
							] }) }), Object.entries(GLOSSARY).map(([group, keys]) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("tbody", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("tr", { children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", {
								colSpan: 3,
								scope: "rowgroup",
								className: "dt-glossary-group",
								children: heading(group)
							}) }), keys.map((key) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("tr", { children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", { children: own[`term.${key}`] }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", { children: other[`term.${key}`] }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", { children: own[`meaning.${key}`] })
							] }, key))] }, group))]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: "dt-legend-title",
							children: t("legendTitle")
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("ul", {
							className: "dt-legend",
							children: [
								"done",
								"ongoing",
								"warning",
								"error",
								"idle"
							].map((state) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Dot, { state }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t(`legend.${state}`) })] }, state))
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("dl", {
							className: "dt-values",
							children: Object.entries(GLOSSARY_VALUES).map(([group, values]) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: { display: "contents" },
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("dt", { children: own[`term.${group}`] }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("dd", { children: values.map((key) => `${own[key]} ${other[key]}`).join(" · ") })]
							}, group))
						})
					]
				})
			});
		}
		function Highlight({ text, query }) {
			const index = query ? text.toLowerCase().indexOf(query.toLowerCase()) : -1;
			if (index < 0) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(react_jsx_runtime.Fragment, { children: text });
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
				text.slice(0, index),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("mark", {
					className: "dt-mark",
					children: text.slice(index, index + query.length)
				}),
				text.slice(index + query.length)
			] });
		}
		function Result({ name, open, children }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("li", {
				className: "dt-row dt-link",
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "dt-row-main",
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "dt-row-title",
						children: open ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: "dt-open",
							onClick: open,
							children: name
						}) : name
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "dt-row-meta",
						children
					})]
				})
			});
		}
		function SearchResults({ result, query, onClose }) {
			const { t, navigate } = usePanel();
			const { setup } = usePanelData();
			const empty = !result.items.length && !result.threads.length && !result.tickets.length;
			const counts = {
				tickets: result.tickets.length,
				threads: result.threads.length,
				items: result.items.length
			};
			const go = (route) => () => {
				onClose();
				navigate(route);
			};
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "dt-search-results",
				role: "region",
				"aria-label": t("searchLabel"),
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "dt-search-head",
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "dt-hint",
						children: empty ? t(setup?.accounts?.feishu ? "searchNone" : "searchNoneGithub") : t(result.items.length >= 20 ? "searchFoundCapped" : "searchFound", counts)
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Button, {
						variant: "ghost",
						size: "sm",
						icon: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Icon, {
							name: "close",
							size: 14
						}),
						"aria-label": t("close"),
						onClick: onClose
					})]
				}), !empty && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("ul", {
					className: "dt-list",
					children: [
						result.tickets.map((ticket) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(Result, {
							name: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Highlight, {
								text: ticket.title,
								query
							}),
							open: go({
								page: "execution",
								id: ticket.id
							}),
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("term.ticket") }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: ticket.stage === "ended" ? t("ticket.ended") : ticketMark(t, ticket).label })]
						}, ticket.id)),
						result.threads.map((thread) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Result, {
							name: readableMarkers(t, thread.title),
							open: go({
								page: "trigger",
								id: thread.key
							}),
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("term.thread") })
						}, thread.key)),
						result.items.map((item) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(Result, {
							name: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Highlight, {
								text: readableMarkers(t, item.preview) || t("empty"),
								query
							}),
							open: item.filtered === void 0 ? go({
								page: "trigger",
								id: item.threads[0],
								query: { trigger: item.id }
							}) : void 0,
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: valueLabel(t, "source", item.source) }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: actorName(t, item.actor) }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(When, { at: item.at }),
								item.threadTitle && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "dt-ellipsis",
									children: t("inThread", { thread: readableMarkers(t, item.threadTitle) })
								}),
								item.filtered !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("searchFiltered", { reason: reasonLabel(t, item.filtered) }) })
							]
						}, item.id))
					]
				})]
			});
		}
		function Header() {
			const { t, call, notify } = usePanel();
			const side = useSide();
			const [glossary, setGlossary] = (0, react.useState)(false);
			const [query, setQuery] = (0, react.useState)("");
			const [result, setResult] = (0, react.useState)();
			const latest = (0, react.useRef)(0);
			const show = (value) => {
				latest.current++;
				setResult(value);
			};
			const search = (0, react.useRef)(null);
			(0, react.useEffect)(() => {
				if (!result) return;
				const close = (event) => {
					if (!search.current?.contains(event.target)) show();
				};
				document.addEventListener("pointerdown", close);
				return () => {
					document.removeEventListener("pointerdown", close);
				};
			}, [result]);
			const submit = (event) => {
				event.preventDefault();
				const text = query.trim();
				if (!text) {
					show();
					return;
				}
				const request = ++latest.current;
				call("GET search", { query: { q: text } }).then((value) => {
					if (request === latest.current) setResult({
						query: text,
						value
					});
				}, (failure) => {
					if (request === latest.current) notify(errorText(failure));
				});
			};
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("header", {
				className: "dt-head",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "dt-head-title",
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("h1", {
							className: "dt-title",
							children: t("title")
						})
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dt-toolbar",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("form", {
								ref: search,
								className: "dt-search",
								role: "search",
								onSubmit: submit,
								onKeyDown: (event) => {
									if (event.key === "Escape") show();
								},
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Input, {
									type: "search",
									icon: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Icon, { name: "search" }),
									value: query,
									placeholder: t("searchPlaceholder"),
									"aria-label": t("searchLabel"),
									onChange: (event) => {
										setQuery(event.target.value);
										if (!event.target.value) show();
									}
								}), result && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(SearchResults, {
									result: result.value,
									query: result.query,
									onClose: () => {
										show();
									}
								})]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Button, {
								variant: "ghost",
								size: "sm",
								icon: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Icon, { name: "question" }),
								"aria-label": t("glossary"),
								title: t("glossary"),
								"aria-haspopup": "dialog",
								onClick: () => setGlossary(true)
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Button, {
								variant: "outline",
								size: "sm",
								icon: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Icon, {
									name: "panel",
									size: 14
								}),
								onClick: () => side.setOpen(true),
								children: t("openOverview")
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Button, {
								variant: "ghost",
								size: "sm",
								icon: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Icon, { name: "panel" }),
								"aria-pressed": side.open,
								"aria-label": t(side.open ? "side.close" : "side.open"),
								title: t(side.open ? "side.close" : "side.open"),
								onClick: () => side.setOpen(!side.open)
							})
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Glossary, {
						open: glossary,
						onClose: () => setGlossary(false)
					})
				]
			});
		}
		function Pages({ route, openTab, deploymentForm }) {
			const { t } = usePanel();
			const { state, error, reload } = usePanelData();
			(0, react.useEffect)(() => {
				document.getElementById(`dt-tab-${route.page}`)?.scrollIntoView?.({
					block: "nearest",
					inline: "nearest"
				});
			}, [route.page]);
			const waiting = error ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
				className: "dt-error",
				role: "alert",
				children: error.message
			}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
				className: "dt-hint",
				children: t("loading")
			});
			const page = (() => {
				switch (route.page) {
					case "chat": return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ChatTab, {});
					case "work": return state ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ExecutionStatus, {
						filter: "open",
						state,
						reload,
						ticketId: route.query?.ticket
					}) : waiting;
					case "source": return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(SourceStatus, {});
					case "trigger": return route.id !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ThreadPage, {
						id: route.id,
						target: route.query?.trigger
					}, route.id) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(TriggerStatus, { filter: route.query?.filter ?? "subscribed" });
					case "eval": return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(EvalStatus, {
						filter: route.query?.filter ?? "work",
						window: route.query?.window,
						paused: !!state?.paused
					});
					case "execution": return route.id !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(TicketPage, { id: route.id }, route.id) : state ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ExecutionStatus, {
						filter: route.query?.filter ?? "open",
						state,
						reload,
						ticketId: route.query?.ticket
					}) : waiting;
					case "settings": return state ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(SettingsPage, {
						group: route.query.group,
						query: route.query,
						state,
						deploymentForm
					}, state.masterId) : waiting;
				}
			})();
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "dt-shell",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					className: "dt-page",
					children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dt-column",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Header, {}),
							error && state && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								className: "dt-error",
								role: "status",
								children: error.message
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(SegmentedTabs, {
								className: "dt-tabs",
								label: t("pagesLabel"),
								value: route.page,
								onChange: openTab,
								items: NAV_TABS.map((value) => ({
									value,
									label: t(`tab.${value}`),
									id: `dt-tab-${value}`,
									panelId: "dt-page"
								}))
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("main", {
								id: "dt-page",
								role: "tabpanel",
								"aria-labelledby": `dt-tab-${route.page}`,
								className: "dt-main",
								children: page
							})
						]
					})
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(SidePanel, { masterId: state?.masterId })]
			});
		}
		/** Root panel component managing route history and shared panel state. */
		function App({ t, openSession, deploymentForm, native }) {
			const [location, setLocation] = (0, react.useState)(initialLocation);
			(0, react.useEffect)(() => {
				remember(location);
			}, [location]);
			const move = (0, react.useCallback)((next) => setLocation((current) => ({
				...next(current),
				group: lastSettingsGroup(current)
			})), []);
			/** Navigates to `route`; `replace` swaps the current entry (filters, paging) instead of pushing a back step. */
			const navigate = (0, react.useCallback)((route, replace = false) => move((current) => ({
				route,
				stack: replace ? current.stack : [...current.stack, current.route].slice(-20)
			})), [move]);
			const back = (0, react.useCallback)(() => move((current) => ({
				route: current.stack.at(-1) ?? HOME,
				stack: current.stack.slice(0, -1)
			})), [move]);
			const openTab = (0, react.useCallback)((tab) => move((current) => ({
				stack: [],
				route: tab === "settings" ? settingsRoute(lastSettingsGroup(current)) : {
					page: tab,
					id: void 0
				}
			})), [move]);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(PanelProvider, {
				t,
				openSession,
				navigate,
				back,
				backLabel: routeLabel(t, location.stack.at(-1) ?? HOME),
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(NativeContext.Provider, {
					value: native,
					children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(WorkProvider, { children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(SideProvider, { children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Pages, {
						route: location.route,
						openTab,
						deploymentForm
					}) }) })
				})
			});
		}
		//#endregion
		//#region src/client/flow-card.tsx
		/** The trigger a settled `superagent_submit` call handed over, read from its JSON result. */
		function triggerOfResult(content) {
			for (const block of content ?? []) {
				if (block.type !== "text" || !block.text) continue;
				try {
					const value = JSON.parse(block.text);
					if (typeof value.trigger === "string" && value.trigger) return value.trigger;
				} catch {}
			}
		}
		/** The supervisor's mark for where a message stands. */
		function supervisorState(flow) {
			if (flow.state === "evaluating" || flow.state === "unknown") return "thinking";
			if (flow.state !== "ticket" || !flow.ticket || flow.ticket.ended) return "idle";
			if (flow.approvals.length || flow.proposal?.state === "proposed") return "alert";
			if (flow.team?.steps.some((step) => step.state === "running")) return "waiting";
			return flow.ticket.stage.stage === "working" ? "working" : "idle";
		}
		function Node({ state, title, children }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", {
				className: "dt-fc-node",
				"data-state": state,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: "dt-fc-dot",
					"aria-hidden": "true"
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "dt-fc-node-main",
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "dt-fc-node-title",
						children: title
					}), children]
				})]
			});
		}
		/**
		* VsSaros addition (2026-11-06): a message a group chat took. The desk records it as `ignore` on purpose (the supervisor
		* stays out of a group's work), so this card says where it went and follows the group's run live, instead of "not taken".
		*/
		function GroupFlow({ group }) {
			const { t, openSession, notify } = usePanel();
			const run = groupRunForFlow(useGroupRuns(), group);
			const status = run ? groupRoundStatus(run) : void 0;
			const replies = run ? groupRunReplies(run).length : 0;
			const latest = run ? groupRunLatestEvent(run) : void 0;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "dt-fc",
				"data-testid": "flow-card",
				"data-state": "group",
				"data-group-room": group.roomId,
				"data-group-run-status": status ?? "",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dt-fc-head",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(BotMark, {
							id: "superagent",
							name: t("chat.supervisor"),
							size: 26,
							state: "idle"
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "dt-fc-head-main",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("b", { children: t(group.kind === "created" ? "flow.groupCreated" : group.kind === "updated" ? "flow.groupUpdated" : "flow.groupRouted", { name: group.roomName }) }), run && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "dt-tag",
								"data-tone": status === "failed" || status === "cut" ? "warning" : status === "done" ? "success" : "info",
								children: t(groupRunStatusKey(run))
							})]
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: "dt-fc-note",
						children: run ? `${t("groupRuns.replies", { n: String(replies) })} · ${t("groupRuns.elapsed", { n: String(groupRunElapsed(run)) })}` + (latest?.text ? ` · ${String(latest.text).slice(0, 80)}` : "") : t("flow.groupNote")
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "dt-row-actions",
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Button, {
							variant: "outline",
							size: "sm",
							"data-act": "open-flow-group",
							onClick: () => {
								openSession(group.roomId).catch((failure) => notify(errorText(failure)));
							},
							children: t("groupRuns.open")
						})
					})
				]
			});
		}
		/**
		* One message's card, kept current by the change stream. VsSaros addition (2026-11-06): `receipt` draws only how its ticket
		* ended (title, outcome, the team's steps, the summary), for the desk's turn that tells the person a ticket ended.
		*/
		function FlowCard({ triggerId, receipt = false }) {
			const { t, call, openSession, notify } = usePanel();
			const { data, error, reload } = useLive(() => call("GET desk/flow/:id", { id: triggerId }), [triggerId], ["tickets", "steps"], 4e3);
			const agree = useAction((input) => call("POST tickets/:id/team/approve", {
				id: input.id,
				body: { version: input.version }
			}), { reload });
			const refuse = useAction((id) => call("POST tickets/:id/team/reject", {
				id,
				body: {}
			}), { reload });
			if (!data) return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "dt-fc dt-fc-line",
				"data-testid": "flow-card",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(BotMark, {
					id: "superagent",
					size: 18,
					state: "thinking"
				}), error ? error.message : t("flow.handed")]
			});
			if (data.state === "group" && data.group) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(GroupFlow, { group: data.group });
			const head = (text, tag) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "dt-fc-head",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(BotMark, {
					id: "superagent",
					name: t("chat.supervisor"),
					size: 26,
					state: supervisorState(data)
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "dt-fc-head-main",
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("b", { children: text }), tag]
				})]
			});
			const alsoGroup = data.group && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
				className: "dt-fc-note",
				"data-testid": "flow-card-group",
				children: [
					t("flow.alsoGroup", { name: data.group.roomName }),
					" ",
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						className: "dt-textlink",
						"data-act": "open-flow-group",
						onClick: () => {
							openSession(data.group.roomId).catch((failure) => notify(errorText(failure)));
						},
						children: t("groupRuns.open")
					})
				]
			});
			if (data.state === "unknown" || data.state === "evaluating") return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: "dt-fc",
				"data-testid": "flow-card",
				children: head(/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: "dt-shimmer",
					children: t(data.unavailable ? "flow.evalRetry" : "flow.evaluating")
				}))
			});
			if (data.state === "filtered" || data.state === "declined") return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "dt-fc",
				"data-testid": "flow-card",
				"data-state": "declined",
				children: [head(t(data.state === "filtered" ? "flow.filtered" : "flow.declined")), data.reasons?.length ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
					className: "dt-fc-note",
					children: reasonLabel(t, data.reasons)
				}) : null]
			});
			const ticket = data.ticket;
			const mark = ticketMark(t, {
				...ticket.stage,
				ended: ticket.ended
			});
			const stage = /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				className: "dt-tag",
				"data-tone": mark.tone,
				children: mark.label
			});
			if (receipt && ticket.ended && !data.followup) {
				const ended = ticket.ended, note = ticket.report?.summary || ended.reason;
				return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "dt-fc",
					"data-testid": "flow-card",
					"data-receipt": "ended",
					"data-outcome": ended.outcome,
					children: [
						head(t("flow.receipt", { title: ticket.title }), stage),
						data.team && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(MiniFlow, { team: data.team }),
						note && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: "dt-fc-note",
							children: note
						})
					]
				});
			}
			if (data.followup) return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "dt-fc dt-fc-line",
				"data-testid": "flow-card",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(BotMark, {
						id: "superagent",
						size: 18
					}),
					t("flow.followup", { title: ticket.title }),
					stage,
					alsoGroup
				]
			});
			const proposal = data.proposal, team = data.team;
			const waitingProposal = proposal?.state === "proposed";
			const proposalState = !proposal ? "wait" : proposal.state === "approved" ? "done" : proposal.state === "rejected" ? "fail" : "active";
			const done = team ? team.steps.filter((step) => step.state === "ready").length : 0;
			const teamState = !team ? "wait" : ticket.ended ? done === team.steps.length ? "done" : "fail" : team.steps.every((step) => [
				"ready",
				"failed",
				"skipped",
				"stopped"
			].includes(step.state)) ? "done" : "active";
			const ended = ticket.ended;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "dt-fc",
				"data-testid": "flow-card",
				children: [
					head(ticket.title, stage),
					alsoGroup,
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("ol", {
						className: "dt-fc-nodes",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Node, {
								state: "done",
								title: t("flow.taken")
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Node, {
								state: proposalState,
								title: proposal ? t("flow.proposal", { version: String(proposal.version) }) : t("flow.proposing"),
								children: proposal && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "dt-fc-proposal",
									children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
											className: "dt-fc-roles",
											children: proposal.roles.map((role) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
												className: "dt-fc-role",
												children: [
													/* @__PURE__ */ (0, react_jsx_runtime.jsx)(BotMark, {
														id: role.bot?.id ?? role.draft?.id ?? role.key,
														size: 18
													}),
													role.bot?.name ?? role.draft?.name ?? role.key,
													role.draft ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("em", { children: t("team.staffingNew") }) : null
												]
											}, role.key))
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
											className: "dt-fc-note",
											children: proposal.steps.map((step) => step.title).join(" → ")
										}),
										(proposal.risk.newBots > 0 || proposal.risk.writeSteps > 0 || proposal.risk.highRiskTools.length > 0) && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
											className: "dt-fc-note",
											children: [
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
													className: "dt-tag",
													"data-tone": "warning",
													children: t("team.risky")
												}),
												" ",
												t("flow.risk", {
													bots: String(proposal.risk.newBots),
													writes: String(proposal.risk.writeSteps)
												})
											]
										}),
										waitingProposal && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
											className: "dt-row-actions",
											children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Button, {
												variant: "primary",
												size: "sm",
												disabled: agree.busy,
												onClick: () => {
													agree.run({
														id: ticket.id,
														version: proposal.version
													});
												},
												children: t("team.staffingAgree")
											}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ConfirmButton, {
												variant: "outline",
												label: t("team.staffingRefuse"),
												title: t("team.staffingRefuseTitle"),
												message: t("team.staffingRefuseConfirm", { title: ticket.title }),
												onConfirm: async () => {
													await refuse.run(ticket.id);
												}
											})]
										})
									]
								})
							}),
							(team || proposal?.state === "approved") && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(Node, {
								state: teamState,
								title: team ? t("flow.team", {
									done: String(done),
									total: String(team.steps.length)
								}) : t("flow.teamStarting"),
								children: [
									team && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(MiniFlow, { team }),
									data.approvals.map((item) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ApprovalCard, { approval: item }, item.id)),
									team && !ended && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(StepMembers, { team })
								]
							}),
							ended ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Node, {
								state: ended.outcome === "completed" || ended.outcome === "merged" ? "done" : "fail",
								title: t("flow.ended", { outcome: valueLabel(t, "outcome", ended.outcome) }),
								children: (ticket.report?.summary || ended.reason) && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									className: "dt-fc-note",
									children: ticket.report?.summary || ended.reason
								})
							}) : ticket.report && ticket.stage.stage === "person" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Node, {
								state: "active",
								title: t("flow.report"),
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									className: "dt-fc-note",
									children: ticket.report.summary
								})
							})
						]
					})
				]
			});
		}
		//#endregion
		//#region src/client/index.tsx
		/** Browser plugin entry point registering the sidebar icon, main management panel, and Plugin Manager config view. */
		const NS = "dshSuperagent";
		const PANEL_ID = "dsh-superagent";
		/** The plugin row's id in the bundle patch (kept from upstream, so saved settings carry over). */
		const ENTRY = "dsh-superagent";
		/**
		
		* ★ 2026-11-10：跨 chunk 旁路统一「记住的群」。
		
		*   本插件的 @群 / 流程卡 / 群执行卡都会调 openSession(roomId)，但 chat-surface 的选中态
		
		*   只在侧栏群行点击时更新 ⇒ Host 仍按旧群放宽转投。这里在 openSession 入口认出群 id，
		
		*   走 client.workspaces.js 注册的桥（没装该 chunk 时静默跳过，不影响打开会话）。
		
		*/
		function noteSelectedRoom(id) {
			try {
				const w = window;
				if (w.__vssarosKnownRoomIds?.has(id) && typeof w.__vssarosSelectRoom === "function") w.__vssarosSelectRoom(id);
			} catch {}
		}
		/** VsSaros change: the package as a VsSaros built-in. */
		const PACKAGE = "@vssaros/dsh-superagent";
		function HammerIcon({ size }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("svg", {
				width: size,
				height: size,
				viewBox: "0 0 24 24",
				fill: "none",
				stroke: "currentColor",
				strokeWidth: 1.8,
				strokeLinecap: "round",
				strokeLinejoin: "round",
				"aria-hidden": true,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M6 3.5h9l3.5 1.75v2.5L15 9.5H6a1 1 0 0 1-1-1v-4a1 1 0 0 1 1-1z" }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M10 9.5v10.25a1.75 1.75 0 0 0 3.5 0V9.5" }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M10 15.5h3.5" })
				]
			});
		}
		/** The host's docked conversation, for the Chat tab; none outside a VsSaros workbench. */
		function nativeOf(workbench) {
			const service = workbench?.service;
			if (!service || workbench.conversation === void 0) return void 0;
			return {
				node: workbench.conversation,
				active: workbench.active !== false,
				dock: async (sessionId) => {
					await service.ensureSession({ sessionId });
				}
			};
		}
		/** Mounted panel wrapper; cancels any pending Session navigation when a new one starts or the panel unmounts. */
		function Mounted({ ctx, t, workbench }) {
			const pending = (0, react.useRef)(void 0);
			(0, react.useEffect)(() => () => {
				pending.current?.abort();
			}, []);
			const openSession = (0, react.useCallback)(async (id) => {
				noteSelectedRoom(id);
				pending.current?.abort();
				const request = new AbortController();
				pending.current = request;
				try {
					await openKnownSession(ctx.sessions, id, (target) => {
						ctx.uiWorkspace.openSession(target);
					}, request.signal);
				} catch (error) {
					if (error instanceof SessionNavigationError) throw new Error(t(error.code === "not-ready" ? "sessionListNotReady" : "sessionNotListed"));
					throw error;
				}
			}, [ctx, t]);
			const form = usePageForm(ctx.get("configForms")?.get(ENTRY));
			const service = workbench?.service, active = workbench?.active;
			const native = (0, react.useMemo)(() => nativeOf(workbench), [
				service,
				active,
				workbench?.conversation !== void 0
			]);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(App, {
				t,
				openSession,
				deploymentForm: form,
				native
			});
		}
		/** The desk's ticket-end tool (`RECEIPT_TOOL` in app/desk.ts, which the client bundle does not import; a test keeps them equal). */
		const RECEIPT_TOOL_NAME = "superagent_ticket_result";
		/**
		
		* The desk's one tool in DSH's chat: while it runs, a line saying the message goes to the supervisor; once it settled, the
		
		* message's key-node card (`flow-card.tsx`), which follows it live. VsSaros addition (2026-11-06): with `receipt`, the
		
		* desk's `superagent_ticket_result` call (made by SuperAgent when a desk ticket ends) as the ticket's end card.
		
		*/
		function deskToolView(ctx, t, receipt = false) {
			const openSession = async (id) => {
				noteSelectedRoom(id);
				try {
					await openKnownSession(ctx.sessions, id, (target) => {
						ctx.uiWorkspace.openSession(target);
					}, new AbortController().signal);
				} catch (error) {
					if (error instanceof SessionNavigationError) throw new Error(t(error.code === "not-ready" ? "sessionListNotReady" : "sessionNotListed"));
					throw error;
				}
			};
			return function DeskToolView({ phase, block }) {
				const trigger = phase === "result" ? triggerOfResult(block?.content) : void 0;
				return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(CardProvider, {
					t,
					openSession,
					children: trigger ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(FlowCard, {
						triggerId: trigger,
						receipt
					}) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dt-fc dt-fc-line",
						"data-testid": "flow-card",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(BotMark, {
							id: "superagent",
							size: 18,
							state: phase === "result" ? "idle" : "sending"
						}), t(receipt ? "flow.receiptLoading" : phase === "result" ? "flow.handed" : "flow.handing")]
					})
				});
			};
		}
		const inject = [
			"slots",
			"locale",
			"sessions",
			"uiWorkspace"
		];
		/**
		
		* VsSaros addition: in VsSaros the panel is a whole-page workbench, a built-in one whose identity is `vssaros:superagent`
		
		* (its package's `vssaros.workbench`; title, description and icon must match it word for word). It frames itself
		
		* (`customFrame`), so the host gives it DSH's own conversation to dock: the Chat tab shows the supervisor desk in it.
		
		*/
		const WORKBENCH = {
			title: "SuperAgent",
			description: "SuperAgent 主管：接收飞书、GitHub、TAPD 和主管对话里的需求，评估后组建 bot 团队，经你同意再分工执行，并沉淀技能。",
			icon: "codicon:robot",
			repository: "vssaros:superagent",
			customFrame: true,
			floatingActions: false
		};
		/** Registers the panel, sidebar icon, and Plugin Manager config view; `configForms` is optional (without it, machine settings are read-only). */
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, {
				zh,
				en
			}), "dsh-superagent: dictionaries");
			ctx.effect(() => () => {
				disposeFeed();
			}, "dsh-superagent: change stream");
			const t = ctx.locale.bind(NS);
			ctx.slots.inject("main", () => ctx.slots.register({
				name: "main",
				key: PANEL_ID,
				locale: NS,
				inject: () => ({})
			}, (props) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Mounted, {
				ctx,
				t: props.t
			})));
			let withdraw;
			ctx.slots.inject("sidebar.panellist", () => {
				const dispose = ctx.slots.register({
					name: "sidebar.panellist",
					id: PANEL_ID,
					order: 10,
					label: () => t("panel"),
					locale: NS
				}, HammerIcon);
				withdraw = dispose;
				return dispose;
			});
			ctx.inject(["desktopWorkbenches"], (child) => {
				const desktopWorkbenches = child.desktopWorkbenches;
				withdraw?.();
				withdraw = void 0;
				child.effect(() => desktopWorkbenches.register(WORKBENCH, (props) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					"data-vssaros-surface": "workbench",
					"data-vssaros-group-tip": "off",
					className: "dt-workbench",
					children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Mounted, {
						ctx,
						t,
						workbench: props
					})
				})), "dsh-superagent: workbench");
			});
			const slots = ctx.slots;
			slots.inject("tool.call.toolview", () => slots.register({
				name: "tool.call.toolview",
				key: "superagent_submit"
			}, deskToolView(ctx, t)));
			slots.inject("tool.call.toolview", () => slots.register({
				name: "tool.call.toolview",
				key: RECEIPT_TOOL_NAME
			}, deskToolView(ctx, t, true)));
			ctx.slots.inject("plugins.row.config", () => ctx.slots.register({
				name: "plugins.row.config",
				key: `${PACKAGE}#${ENTRY}`,
				locale: NS
			}, (props) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(PluginConfig, {
				t: props.t,
				view: props.view,
				form: props.form
			})));
		}
		//#endregion
		exports.RECEIPT_TOOL_NAME = RECEIPT_TOOL_NAME;
		exports.WORKBENCH = WORKBENCH;
		exports.apply = apply;
		exports.inject = inject;
		exports.nativeOf = nativeOf;
		return module.exports;
	}
});
