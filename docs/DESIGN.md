# Design System: Mockix

Mockix uses the **Sendix design system unchanged** ("The Stone Workbench", [DESIGN-base.md](DESIGN-base.md)):

- three stones per theme, and grey-green #5c6b54 only on the primary action, the selection tint and the focus ring;
- Archivo 11–15px, with the wordmark as the ceiling, and JetBrains Mono with ligatures off;
- earth inks for methods and statuses, always next to their word;
- the strata bar as signature.

Both apps belong to the protohub.digital family. This file lists only what Mockix adds.

## Shell

Same grid as Sendix (38px title bar, 44px rail, 264px sidebar, main area, 24px status bar, reference frame 1440×900). Differences:

- **Title bar**: the environment picker becomes the **mock pill**: status dot, mock name, mono port and the word "En marcha" or "Detenido". Next to it, a stop icon button.
- **Rail**: Mocks y rutas, Grabaciones, Escenarios, Caos, Contratos; Agentes (MCP) and Ajustes at the bottom. Each section has its own sidebar.
- **Status bar**: running mocks with their ports, workspace path, MCP state, control API state, and the "Datos de ejemplo" tag.

## Additions

- **Running state**: a filled Pass Green dot plus the port means running; a hollow faint ring plus the word "detenido" means stopped. The state is never carried by colour alone.
- **Path parameters** (`:id`, `{id}`) use Variable Amber, like variables in Sendix. On a selected row they switch to `select-ink`.
- **CRUD verb** uses the PUT ink (`m-put`).
- **Response chips**: 26px outlined chips, one per response of the route: status code in mono with its status ink, plus the response name. The default response carries a faint flag icon labelled "Por defecto". The pressed chip uses the Field fill, the Strong Seam border and weight 600.
- **Response order table**: order number, response, condition in mono (rule target in amber), and hit count right-aligned. The response mode (Reglas / Aleatorio / Secuencial / Fallback) is a segmented control in the section head.
- **Live log rows**: a 30px grid with time, status code and phrase in the status ink, method, path, then the matched response name plus outlined tags (`caos`, `escenario`), and the total right-aligned. A contract violation tag is outlined in Fail Brick, which follows the Earned Colour Rule.
- **Mock strata**: the phases are Recepción, Proceso, Latencia, Caos and Envío. The note at the right says how much of the total was simulated ("simulado 160 ms · total 167 ms"). The stones still mean sequence only.
- **Scenario diagram**: states are 34px Workbench boxes with a Strong Seam border. Final states have a dashed border. The current state of the selected instance takes the Selection Moss tint with a Focus Moss border. The path already taken is drawn in muted, pending edges in Strong Seam, and time-based transitions are labelled in amber mono. The count inside each box is the number of live instances.
- **Chaos chart**: on a Field well. Latency is a 1.8px ink polyline with control points as circles (the selected one is filled). Jitter is a `strata-1` band. The error rate is drawn as bars in the Fail Brick tint (injected failures, so they earn the colour), on the right axis. "Now" is a dashed Focus Moss line with a label. Units go in the legend, not on the axes.
- **Recording chip**: an ink dot that pulses (static under `prefers-reduced-motion`) next to the word "Grabando" and the elapsed time. Recording is not a failure, so it is not red.
- **MCP approval dialog**: the **only shadowed surface** (a floating layer, as the Flat Stone Rule allows). It is 440px wide at the bottom right of the main area. It shows the client, tool and file as a definition list, a one-line summary with the method ink, and the YAML to be written as `+` lines in neutral ink (additions are not "success", so they are not green). The footer holds "Confiar en este agente durante la sesión", Rechazar (secondary) and Aprobar (primary).

## Rules carried over

No text above 15px or below 11px. No large empty regions: tall panes are filled with context such as transitions, recent events, per-route chaos or live violations. Every colour goes with a word. Both themes keep WCAG AA.
