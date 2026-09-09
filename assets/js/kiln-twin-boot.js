(function (global) {
    'use strict';

    const VERSION = '0.4.2';
    const SCRIPT_URL = global.document?.currentScript?.src || '';
    const SCRIPT_PROMISES = global.__kilnTwinScriptPromises || (global.__kilnTwinScriptPromises = {});
    const MODULE_PROMISES = global.__kilnTwinModulePromises || (global.__kilnTwinModulePromises = {});
    const DEFAULT_IDS = {
        stage: 'kiln-stage',
        root: 'kiln-twin-root',
        topbar: 'kiln-twin-topbar',
        envTime: 'kiln-twin-env-time',
        envAmbient: 'kiln-twin-env-ambient',
        envHumidity: 'kiln-twin-env-humidity',
        envConnection: 'kiln-twin-env-connection',
        toolbar: 'kiln-twin-toolbar',
        toolbarReset: 'kiln-twin-toolbar-reset',
        toolbarPlayback: 'kiln-twin-toolbar-playback',
        toolbarModeLegacy: 'kiln-twin-toolbar-mode-legacy',
        toolbarModeTwin: 'kiln-twin-toolbar-mode-twin',
        toolbarModeSplit: 'kiln-twin-toolbar-mode-split',
        viewport: 'kiln-twin-viewport',
        legacy: 'threejs-container',
        legacyHost: 'kiln-twin-legacy-host',
        scene: 'kiln-twin-scene-mount',
        css2d: 'kiln-twin-css2d-root',
        ui: 'kiln-twin-ui-overlay',
        sidePanel: 'kiln-twin-side-panel',
        panelTitle: 'kiln-twin-panel-title',
        panelSubtitle: 'kiln-twin-panel-subtitle',
        statusPill: 'kiln-twin-status-pill',
        panelStack: 'kiln-twin-panel-stack',
        slotOverview: 'kiln-twin-panel-slot-overview',
        slotMetrics: 'kiln-twin-panel-slot-metrics',
        slotInspector: 'kiln-twin-panel-slot-inspector',
    };
    const DEFAULT_URLS = {
        scene: `./kiln-scene.js?v=${VERSION}`,
        overlays: `./kiln-overlays.js?v=${VERSION}`,
        dashboard: `./kiln-dashboard.js?v=${VERSION}`,
        controller: `./kiln-controller.js?v=${VERSION}`,
        telemetryMock: `./kiln-telemetry-mock.js?v=${VERSION}`,
    };
    const DEFAULT_EVENT_NAMES = Object.freeze({
        telemetry: 'kiln:twin:telemetry',
        module: 'kiln:twin:module-change',
        status: 'kiln:twin:status',
        dashboardSelect: 'kiln:dashboard:module-select',
    });
    const DEFAULT_TELEMETRY = Object.freeze({
        temp: 1188,
        efficiency: 87.8,
        ambientTemp: 25,
        humidity: 45,
        product_type: 'small',
        radiation_state: 'weaken',
        emissions: {
            CO2: 452,
            NOx: 31,
        },
    });

    function resolveElement(input, fallbackId) {
        if (input && typeof input === 'object' && input.nodeType === 1) return input;
        if (typeof input === 'string' && input) {
            return global.document.getElementById(input) || global.document.querySelector(input);
        }
        if (fallbackId) return global.document.getElementById(fallbackId);
        return null;
    }

    function scheduleLayoutSync(callback) {
        if (typeof callback !== 'function') return;
        if (typeof global.requestAnimationFrame === 'function') {
            global.requestAnimationFrame(() => callback());
            return;
        }
        callback();
    }

    function appendContent(target, content) {
        if (!target || content == null) return;
        if (typeof content === 'string') {
            target.insertAdjacentHTML('beforeend', content);
            return;
        }
        if (Array.isArray(content)) {
            content.forEach((item) => appendContent(target, item));
            return;
        }
        if (content.nodeType) {
            target.appendChild(content);
        }
    }

    function sanitizeMode(mode) {
        return mode === 'twin' ? 'twin' : 'twin';
    }

    function clone(value) {
        if (value == null) return value;
        try {
            return JSON.parse(JSON.stringify(value));
        } catch (error) {
            return value;
        }
    }

    function toFiniteNumber(value) {
        const numeric = Number(value);
        return Number.isFinite(numeric) ? numeric : null;
    }

    function resolveAssetUrl(path) {
        if (!path) return '';
        try {
            return new URL(path, SCRIPT_URL || global.location.href).href;
        } catch (error) {
            return path;
        }
    }

    function loadScript(url, options) {
        const source = resolveAssetUrl(url);
        const settings = options || {};

        if (typeof settings.check === 'function' && settings.check()) {
            return Promise.resolve(true);
        }
        if (!source) {
            return Promise.reject(new Error('Invalid script URL.'));
        }
        if (SCRIPT_PROMISES[source]) {
            return SCRIPT_PROMISES[source];
        }

        SCRIPT_PROMISES[source] = new Promise((resolve, reject) => {
            const existing = global.document.querySelector(`script[data-kiln-twin-src="${source}"]`);
            if (existing) {
                existing.addEventListener('load', () => resolve(true), { once: true });
                existing.addEventListener('error', () => reject(new Error(`Failed to load ${source}`)), { once: true });
                return;
            }

            const script = global.document.createElement('script');
            script.src = source;
            script.async = true;
            script.dataset.kilnTwinSrc = source;
            script.addEventListener('load', () => resolve(true), { once: true });
            script.addEventListener('error', () => reject(new Error(`Failed to load ${source}`)), { once: true });
            global.document.head.appendChild(script);
        });

        return SCRIPT_PROMISES[source];
    }

    function importModule(url) {
        const source = resolveAssetUrl(url);
        if (!source) {
            return Promise.reject(new Error('Invalid module URL.'));
        }
        if (MODULE_PROMISES[source]) {
            return MODULE_PROMISES[source];
        }
        MODULE_PROMISES[source] = import(source);
        return MODULE_PROMISES[source];
    }

    async function loadDependencySet(config) {
        const urls = {
            ...DEFAULT_URLS,
            ...(config.urls || {}),
        };
        const results = {
            scene: null,
            overlays: null,
            dashboard: null,
            controller: null,
            errors: [],
        };

        const settled = await Promise.allSettled([
            loadScript(urls.telemetryMock, { check: () => !!global.KilnTwinTelemetryMock }),
            loadScript(urls.overlays, { check: () => typeof global.createKilnOverlays === 'function' }),
            loadScript(urls.dashboard, { check: () => typeof global.createKilnDashboard === 'function' }),
            loadScript(urls.controller, { check: () => typeof global.KilnTwinController?.create === 'function' }),
            importModule(urls.scene),
        ]);

        if (settled[1].status === 'fulfilled' && typeof global.createKilnOverlays === 'function') {
            results.overlays = global.createKilnOverlays;
        } else if (settled[1].status === 'rejected') {
            results.errors.push(settled[1].reason);
        }

        if (settled[2].status === 'fulfilled' && typeof global.createKilnDashboard === 'function') {
            results.dashboard = global.createKilnDashboard;
        } else if (settled[2].status === 'rejected') {
            results.errors.push(settled[2].reason);
        }

        if (settled[3].status === 'fulfilled' && typeof global.KilnTwinController?.create === 'function') {
            results.controller = global.KilnTwinController;
        } else if (settled[3].status === 'rejected') {
            results.errors.push(settled[3].reason);
        }

        if (settled[4].status === 'fulfilled') {
            results.scene = settled[4].value?.createKilnScene || global.createKilnScene || null;
        } else {
            results.errors.push(settled[4].reason);
        }

        return results;
    }

    function createElement(tagName, className, text) {
        const element = global.document.createElement(tagName);
        if (className) element.className = className;
        if (text != null) element.textContent = text;
        return element;
    }

    function createMetricCell(id, labelText, valueText, accent) {
        const cell = createElement('div', 'kiln-twin-metric');
        if (accent) cell.dataset.accent = accent;
        const label = createElement('span', 'kiln-twin-metric__label', labelText);
        const value = createElement('span', 'kiln-twin-metric__value', valueText || '--');
        if (id) value.id = id;
        cell.append(label, value);
        return cell;
    }

    function createToolbarButton(id, labelText, hintText, tone) {
        const button = createElement('button', 'kiln-twin-toolbar__button');
        button.type = 'button';
        if (id) button.id = id;
        if (tone) button.dataset.tone = tone;

        const label = createElement('span', 'kiln-twin-toolbar__label', labelText);
        const hint = createElement('span', 'kiln-twin-toolbar__hint', hintText);
        button.append(label, hint);
        return button;
    }

    function createModeButton(id, labelText, mode) {
        const button = createElement('button', 'kiln-twin-toolbar__mode');
        button.type = 'button';
        button.id = id;
        button.dataset.mode = mode;
        button.textContent = labelText;
        return button;
    }

    function createSlotPlaceholder(id, slotName, hintText) {
        const slot = createElement('section', 'kiln-twin-panel-slot');
        slot.id = id;
        slot.dataset.kilnTwinSlot = slotName;
        const slotLabelMap = {
            overview: 'Overview',
            metrics: 'Parameters',
            inspector: 'Controls',
        };
        const label = createElement('div', 'kiln-twin-panel-slot__label', slotLabelMap[slotName] || slotName);
        const hint = createElement('div', 'kiln-twin-panel-slot__hint', hintText);
        slot.append(label, hint);
        return slot;
    }

    function ensureShellScaffold(config) {
        const stage = resolveElement(config.stage, DEFAULT_IDS.stage);
        const legacy = resolveElement(config.legacy, DEFAULT_IDS.legacy);

        if (!stage || !legacy) return null;

        let root = resolveElement(config.root, DEFAULT_IDS.root);
        if (!root) {
            root = createElement('div', 'kiln-twin-shell');
            root.id = DEFAULT_IDS.root;
            stage.appendChild(root);
        }

        const topbar = createElement('header', 'kiln-twin-topbar');
        topbar.id = DEFAULT_IDS.topbar;

        const brand = createElement('div', 'kiln-twin-topbar__brand');
        const eyebrow = createElement('div', 'kiln-twin-topbar__eyebrow', 'Kiln Digital Twin');
        const title = createElement('h3', 'kiln-twin-topbar__title', 'Real-Time Kiln Environment Monitoring');
        brand.append(eyebrow, title);

        const metricRow = createElement('div', 'kiln-twin-topbar__metrics');
        metricRow.append(
            createMetricCell(DEFAULT_IDS.envTime, 'Time', '--:--:--', 'cyan'),
            createMetricCell(DEFAULT_IDS.envAmbient, 'Temperature', `${DEFAULT_TELEMETRY.temp}℃`, 'amber'),
            createMetricCell(DEFAULT_IDS.envHumidity, 'Efficiency', `${DEFAULT_TELEMETRY.efficiency}%`, 'green'),
            createMetricCell(DEFAULT_IDS.envConnection, 'Radiation State', 'Reduced', 'active')
        );
        topbar.append(brand, metricRow);

        const main = createElement('div', 'kiln-twin-main');

        const toolbar = createElement('aside', 'kiln-twin-toolbar');
        toolbar.id = DEFAULT_IDS.toolbar;
        const toolbarRail = createElement('div', 'kiln-twin-toolbar__rail');
        const toolbarHeading = createElement('div', 'kiln-twin-toolbar__heading');
        toolbarHeading.append(
            createElement('div', 'kiln-twin-section-title', 'Sidebar Status')
        );
        const toolbarStack = createElement('div', 'kiln-twin-toolbar__stack');
        const toolbarOverviewSlot = createSlotPlaceholder(DEFAULT_IDS.slotOverview, 'overview', 'Holds the scene summary, operating state, and mounting notes.');
        const toolbarInspectorSlot = createSlotPlaceholder(DEFAULT_IDS.slotInspector, 'inspector', 'Holds the key parameter cards and focus information from the left side.');
        toolbarStack.append(toolbarOverviewSlot, toolbarInspectorSlot);

        const resetButton = createToolbarButton(DEFAULT_IDS.toolbarReset, 'Reset', 'Restore current preview', 'ghost');
        const playbackButton = createToolbarButton(DEFAULT_IDS.toolbarPlayback, 'Start', 'Controller ready', 'primary');
        const viewportActions = createElement('div', 'kiln-twin-viewport-actions');
        viewportActions.append(resetButton, playbackButton);
        const modeGroup = createElement('div', 'kiln-twin-toolbar__modes');
        modeGroup.append(
            createModeButton(DEFAULT_IDS.toolbarModeLegacy, 'Compatibility View', 'legacy'),
            createModeButton(DEFAULT_IDS.toolbarModeTwin, 'Twin View', 'twin'),
            createModeButton(DEFAULT_IDS.toolbarModeSplit, 'Split View', 'split')
        );
        toolbarRail.append(toolbarHeading, toolbarStack, modeGroup);
        toolbar.appendChild(toolbarRail);

        const centerColumn = createElement('section', 'kiln-twin-center');

        const centerFrame = createElement('div', 'kiln-twin-center__frame');
        const viewport = resolveElement(config.viewport, DEFAULT_IDS.viewport) || createElement('div', 'kiln-twin-viewport');
        viewport.id = DEFAULT_IDS.viewport;
        viewport.className = 'kiln-twin-viewport';

        const legacyHost = createElement('div', 'kiln-twin-layer kiln-twin-layer-legacy');
        legacyHost.id = DEFAULT_IDS.legacyHost;
        legacyHost.replaceChildren(legacy);

        const scene = resolveElement(config.scene, DEFAULT_IDS.scene) || createElement('div', 'kiln-twin-layer kiln-twin-layer-scene');
        scene.id = DEFAULT_IDS.scene;
        scene.className = 'kiln-twin-layer kiln-twin-layer-scene';
        scene.dataset.kilnTwinRole = 'scene';

        const css2d = resolveElement(config.css2d, DEFAULT_IDS.css2d) || createElement('div', 'kiln-twin-layer kiln-twin-layer-css2d');
        css2d.id = DEFAULT_IDS.css2d;
        css2d.className = 'kiln-twin-layer kiln-twin-layer-css2d';
        css2d.dataset.kilnTwinRole = 'css2d';

        const ui = resolveElement(config.ui, DEFAULT_IDS.ui) || createElement('div', 'kiln-twin-layer kiln-twin-layer-ui');
        ui.id = DEFAULT_IDS.ui;
        ui.className = 'kiln-twin-layer kiln-twin-layer-ui';
        ui.dataset.kilnTwinRole = 'ui';

        viewport.replaceChildren(legacyHost, scene, css2d, ui);
        viewport.appendChild(viewportActions);

        const viewportCaption = createElement('div', 'kiln-twin-center__caption');
        viewportCaption.append(
            createElement('span', 'kiln-twin-center__caption-chip', 'Main 3D Viewport'),
            createElement('span', 'kiln-twin-center__caption-chip', 'Parameters Sync with Viewport'),
            createElement('span', 'kiln-twin-center__caption-chip kiln-twin-center__caption-chip--active', 'Drag to rotate / scroll to zoom')
        );
        centerFrame.append(viewport, viewportCaption);
        centerColumn.append(centerFrame);

        const sidePanel = resolveElement(config.sidePanel, DEFAULT_IDS.sidePanel) || createElement('aside', 'kiln-twin-side-panel');
        sidePanel.id = DEFAULT_IDS.sidePanel;
        sidePanel.className = 'kiln-twin-side-panel';
        sidePanel.dataset.kilnTwinRole = 'panel';

        const panelHeader = createElement('div', 'kiln-twin-side-panel__header');
        const panelHeading = createElement('div', 'kiln-twin-side-panel__heading');
        const panelEyebrow = createElement('div', 'kiln-twin-side-panel__eyebrow', 'Right-Side Parameter Area');
        const panelTitle = createElement('h4', 'kiln-twin-side-panel__title', 'Twin Module Panel');
        panelTitle.id = DEFAULT_IDS.panelTitle;
        const panelSubtitle = createElement('p', 'kiln-twin-side-panel__subtitle', 'The right side keeps only parameter panels, concentrates detailed cards, and removes unused structural placeholders.');
        panelSubtitle.id = DEFAULT_IDS.panelSubtitle;
        panelHeading.append(panelEyebrow, panelTitle, panelSubtitle);

        const statusPill = createElement('span', 'kiln-twin-status-pill', 'Compatibility Mode');
        statusPill.id = DEFAULT_IDS.statusPill;
        statusPill.dataset.tone = 'neutral';
        panelHeader.append(panelHeading, statusPill);

        const panelScroll = createElement('div', 'kiln-twin-side-panel__scroll');
        const panelStack = createElement('div', 'kiln-twin-panel-stack');
        panelStack.id = DEFAULT_IDS.panelStack;
        panelStack.append(
            createSlotPlaceholder(DEFAULT_IDS.slotMetrics, 'metrics', 'Holds the right-side parameter cards and the scrolling information area.')
        );
        panelScroll.appendChild(panelStack);
        sidePanel.replaceChildren(panelHeader, panelScroll);

        main.replaceChildren(toolbar, centerColumn, sidePanel);
        root.replaceChildren(topbar, main);

        return root;
    }

    function buildHooks(config) {
        return {
            stage: resolveElement(config.stage, DEFAULT_IDS.stage),
            root: resolveElement(config.root, DEFAULT_IDS.root),
            topbar: resolveElement(config.topbar, DEFAULT_IDS.topbar),
            envTime: resolveElement(config.envTime, DEFAULT_IDS.envTime),
            envAmbient: resolveElement(config.envAmbient, DEFAULT_IDS.envAmbient),
            envHumidity: resolveElement(config.envHumidity, DEFAULT_IDS.envHumidity),
            envConnection: resolveElement(config.envConnection, DEFAULT_IDS.envConnection),
            toolbar: resolveElement(config.toolbar, DEFAULT_IDS.toolbar),
            toolbarReset: resolveElement(config.toolbarReset, DEFAULT_IDS.toolbarReset),
            toolbarPlayback: resolveElement(config.toolbarPlayback, DEFAULT_IDS.toolbarPlayback),
            toolbarModes: {
                legacy: resolveElement(config.toolbarModeLegacy, DEFAULT_IDS.toolbarModeLegacy),
                twin: resolveElement(config.toolbarModeTwin, DEFAULT_IDS.toolbarModeTwin),
                split: resolveElement(config.toolbarModeSplit, DEFAULT_IDS.toolbarModeSplit),
            },
            viewport: resolveElement(config.viewport, DEFAULT_IDS.viewport),
            legacy: resolveElement(config.legacy, DEFAULT_IDS.legacy),
            scene: resolveElement(config.scene, DEFAULT_IDS.scene),
            css2d: resolveElement(config.css2d, DEFAULT_IDS.css2d),
            ui: resolveElement(config.ui, DEFAULT_IDS.ui),
            sidePanel: resolveElement(config.sidePanel, DEFAULT_IDS.sidePanel),
            panelTitle: resolveElement(config.panelTitle, DEFAULT_IDS.panelTitle),
            panelSubtitle: resolveElement(config.panelSubtitle, DEFAULT_IDS.panelSubtitle),
            statusPill: resolveElement(config.statusPill, DEFAULT_IDS.statusPill),
            panelStack: resolveElement(config.panelStack, DEFAULT_IDS.panelStack),
            slots: {
                overview: resolveElement(config.slotOverview, DEFAULT_IDS.slotOverview),
                metrics: resolveElement(config.slotMetrics, DEFAULT_IDS.slotMetrics),
                inspector: resolveElement(config.slotInspector, DEFAULT_IDS.slotInspector),
            },
        };
    }

    function normalizeProductType(value, fallback) {
        const source = String(value || fallback || 'small').trim().toLowerCase();
        return source === 'small' ? 'small' : 'large';
    }

    function normalizeRadiationState(value, fallback) {
        const source = String(value || fallback || 'steady').trim().toLowerCase();
        if (['enhance', 'enhanced', 'high', 'strong', 'inward'].includes(source)) return 'enhance';
        if (['weaken', 'weakened', 'low', 'outward'].includes(source)) return 'weaken';
        return 'steady';
    }

    function deriveTelemetryFromSceneState(sceneState, lastTelemetry) {
        const previousTelemetry = lastTelemetry?.telemetry || lastTelemetry || {};
        const productType = normalizeProductType(
            sceneState?.productType ?? sceneState?.product_type ?? sceneState?.sceneKey,
            previousTelemetry.product_type
        );
        const flameProfile = sceneState?.flameProfile ?? sceneState?.flame_profile ?? previousTelemetry.flameProfile ?? previousTelemetry.flame_profile;
        const trend = productType === 'small' ? 'weaken' : 'enhance';
        const modeKey = String(sceneState?.mode || '').trim().toLowerCase();
        const explicitTemp = toFiniteNumber(sceneState?.temp ?? sceneState?.temperature);
        const baseTemp = modeKey.includes('emission')
            ? 1186
            : productType === 'small'
                ? 1206
                : 1153;
        const resolvedTemp = explicitTemp ?? (Number(previousTelemetry.temp) || baseTemp);

        return {
            timestamp: Date.now(),
            telemetry: {
                temp: resolvedTemp,
                temperature: resolvedTemp,
                efficiency: Number(previousTelemetry.efficiency) || (productType === 'small' ? 90.4 : 85.2),
                ambientTemp: toFiniteNumber(sceneState?.ambientTemp ?? sceneState?.ambient_temp) ?? (Number(previousTelemetry.ambientTemp) || DEFAULT_TELEMETRY.ambientTemp),
                humidity: toFiniteNumber(sceneState?.humidity) ?? (Number(previousTelemetry.humidity) || DEFAULT_TELEMETRY.humidity),
                product_type: productType,
                productType,
                radiation_state: trend,
                radiationState: trend,
                radiationMode: productType === 'small' ? 'inward' : 'outward',
                radiation_mode: productType === 'small' ? 'inward' : 'outward',
                flameProfile,
                flame_profile: flameProfile,
                emissions: {
                    CO2: Number(previousTelemetry.emissions?.CO2) || DEFAULT_TELEMETRY.emissions.CO2,
                    NOx: Number(previousTelemetry.emissions?.NOx) || DEFAULT_TELEMETRY.emissions.NOx,
                },
            },
        };
    }

    function resolveRuntimeSceneState(config, fallbackState) {
        const provider = typeof config.getSceneState === 'function'
            ? config.getSceneState
            : (typeof global.getKilnTwinSceneState === 'function' ? global.getKilnTwinSceneState : null);
        let resolved = null;
        try {
            resolved = typeof provider === 'function' ? provider() : null;
        } catch (error) {
            console.warn('[KilnTwinBoot] read page scene state failed', error);
        }
        if (!resolved || typeof resolved !== 'object') {
            resolved = fallbackState && typeof fallbackState === 'object' ? fallbackState : {};
        }

        const productType = normalizeProductType(
            resolved.productType ?? resolved.product_type ?? resolved.sceneKey,
            fallbackState?.productType ?? fallbackState?.product_type ?? DEFAULT_TELEMETRY.product_type
        );
        const temperature = toFiniteNumber(resolved.temp ?? resolved.temperature)
            ?? toFiniteNumber(fallbackState?.temp ?? fallbackState?.temperature)
            ?? DEFAULT_TELEMETRY.temp;
        const radiationState = productType === 'small' ? 'weaken' : 'enhance';

        return {
            ...(fallbackState || {}),
            ...resolved,
            sceneKey: resolved.sceneKey || productType,
            productType,
            product_type: productType,
            temp: temperature,
            temperature,
            trend: radiationState,
            radiation_state: radiationState,
            radiationState,
            radiationMode: productType === 'small' ? 'inward' : 'outward',
            radiation_mode: productType === 'small' ? 'inward' : 'outward',
        };
    }

    function mergeTelemetryWithSceneState(payload, sceneState, previousPayload) {
        const previewPayload = deriveTelemetryFromSceneState(sceneState, previousPayload || payload);
        if (!payload || typeof payload !== 'object') {
            return previewPayload;
        }

        if (payload.telemetry && typeof payload.telemetry === 'object') {
            const mergedFlameProfile = payload.telemetry.flameProfile
                ?? payload.telemetry.flame_profile
                ?? previewPayload.telemetry.flameProfile
                ?? previewPayload.telemetry.flame_profile;
            return {
                ...payload,
                timestamp: payload.timestamp ?? previewPayload.timestamp,
                telemetry: {
                    ...previewPayload.telemetry,
                    ...payload.telemetry,
                    flameProfile: mergedFlameProfile,
                    flame_profile: mergedFlameProfile,
                    emissions: {
                        ...previewPayload.telemetry.emissions,
                        ...(payload.telemetry.emissions || {}),
                    },
                },
            };
        }

        const mergedFlameProfile = payload.flameProfile
            ?? payload.flame_profile
            ?? previewPayload.telemetry.flameProfile
            ?? previewPayload.telemetry.flame_profile;
        return {
            ...payload,
            timestamp: payload.timestamp ?? previewPayload.timestamp,
            ...previewPayload.telemetry,
            flameProfile: mergedFlameProfile,
            flame_profile: mergedFlameProfile,
            emissions: {
                ...previewPayload.telemetry.emissions,
                ...(payload.emissions || {}),
            },
        };
    }

    function formatStatusText(status, detail) {
        const reason = String(status || detail?.reason || '').trim().toLowerCase();
        if (reason === 'loading') return 'Twin loading';
        if (reason === 'ready') return 'Twin ready';
        if (reason === 'connecting') return 'Syncing connection';
        if (reason === 'connected') return 'Connection stable';
        if (reason === 'playing') return 'Telemetry live';
        if (reason === 'paused') return 'Process running';
        if (reason === 'error') return 'Compatibility mode';
        if (reason === 'destroyed') return 'Twin stopped';
        return 'Compatibility mode';
    }

    function toneForStatus(status) {
        const reason = String(status || '').trim().toLowerCase();
        if (reason === 'error') return 'warning';
        if (reason === 'playing' || reason === 'connected' || reason === 'ready') return 'active';
        return 'neutral';
    }

    function toText(value, fallback) {
        const text = String(value ?? '').trim();
        return text || fallback;
    }

    function formatShortTime(value) {
        if (value == null || value === '') return '--:--:--';

        let date = null;
        if (typeof value === 'number') {
            date = new Date(value < 1e12 ? value * 1000 : value);
        } else {
            const parsed = new Date(value);
            if (!Number.isNaN(parsed.getTime())) date = parsed;
        }

        if (!date || Number.isNaN(date.getTime())) return '--:--:--';

        return new Intl.DateTimeFormat(undefined, {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
        }).format(date);
    }

    function normalizeTelemetryPayload(payload) {
        if (payload && typeof payload === 'object' && payload.telemetry && typeof payload.telemetry === 'object') {
            return {
                ...payload.telemetry,
                timestamp: payload.timestamp ?? payload.telemetry.timestamp,
            };
        }
        return payload || {};
    }

    function mapControllerModuleToPanelKey(moduleKey) {
        const key = String(moduleKey || '').trim().toLowerCase();
        if (key === 'emission') return 'emissions';
        if (key === 'firing') return 'flame';
        if (key === 'holding') return 'efficiency';
        if (key === 'preheat') return 'temperature';
        return 'temperature';
    }

    function normalizeFocusLayerKey(panelKey) {
        const key = String(panelKey || '').trim().toLowerCase();
        if (!key) return 'all';
        if (['temperature', 'efficiency', 'environment', 'structure'].includes(key)) return 'structure';
        if (['product', 'products'].includes(key)) return 'products';
        if (['emission', 'emissions', 'radiation'].includes(key)) return 'radiation';
        if (['flame', 'flames'].includes(key)) return 'flame';
        return 'all';
    }

    function getPanelLabel(panelKey) {
        const key = String(panelKey || '').trim().toLowerCase();
        if (key === 'temperature') return 'Temperature';
        if (key === 'product') return 'Product';
        if (key === 'emissions') return 'Emissions';
        if (key === 'efficiency') return 'Efficiency';
        if (key === 'flame') return 'Flame';
        if (key === 'environment') return 'Environment';
        return panelKey || 'Panel';
    }

    function formatFocusLayerLabel(layerKey) {
        const key = String(layerKey || '').trim().toLowerCase();
        if (!key || key === 'all') return 'All Layers';
        if (key === 'structure') return 'Kiln Structure';
        if (key === 'products') return 'Product Layer';
        if (key === 'radiation') return 'Radiation Layer';
        if (key === 'flame') return 'Flame Layer';
        return layerKey || 'Unassigned';
    }

    function createInstance(config) {
        ensureShellScaffold(config);
        const hooks = buildHooks(config);
        if (
            !hooks.stage ||
            !hooks.root ||
            !hooks.viewport ||
            !hooks.legacy ||
            !hooks.scene ||
            !hooks.css2d ||
            !hooks.ui ||
            !hooks.sidePanel ||
            !hooks.statusPill ||
            !hooks.slots.overview ||
            !hooks.slots.metrics ||
            !hooks.slots.inspector
        ) {
            console.warn('[KilnTwinBoot] Missing required DOM hooks, boot skipped.');
            return null;
        }

        const state = {
            mode: sanitizeMode(config.mode),
            preferredMode: sanitizeMode(config.mode || config.liveMode || 'split'),
            sceneState: resolveRuntimeSceneState(config, config.sceneState),
            lifecycle: 'idle',
            lastTelemetry: null,
            statusDetail: null,
            moduleList: [],
            moduleKey: null,
            moduleLabel: null,
            selectedPanelKey: null,
            selectedPanelLabel: null,
            focusLayerKey: 'all',
            bootError: null,
            hasUserModeOverride: false,
        };
        const runtime = {
            destroyed: false,
            startPromise: null,
            resizeObserver: null,
            modules: null,
            scene: null,
            overlays: null,
            dashboard: null,
            controller: null,
            ui: null,
            css2dBadge: null,
            sceneStateSyncTimer: null,
            toolbarBound: false,
            syncingDashboardSelection: false,
        };

        function syncShellLayout() {
            if (runtime.scene && typeof runtime.scene.resize === 'function') {
                try {
                    runtime.scene.resize();
                } catch (error) {
                    console.warn('[KilnTwinBoot] scene resize failed', error);
                }
            }
            scheduleLayoutSync(config.syncLayout);
        }

        function ensureCss2dBadge() {
            if (runtime.css2dBadge || !hooks.css2d) return runtime.css2dBadge;
            const badge = createElement('div', 'kiln-twin-css2d-badge');
            hooks.css2d.replaceChildren(badge);
            runtime.css2dBadge = badge;
            return badge;
        }

        function updateCss2dBadge() {
            const badge = ensureCss2dBadge();
            if (!badge) return;
            const sceneState = state.sceneState || {};
            const telemetry = state.lastTelemetry?.telemetry || {};
            const productType = normalizeProductType(
                telemetry.product_type ?? sceneState.productType ?? sceneState.sceneKey,
                'large'
            );
            const radiationState = normalizeRadiationState(
                telemetry.radiation_state ?? sceneState.trend,
                'steady'
            );
            const temp = Number(telemetry.temp ?? telemetry.temperature ?? sceneState.temp ?? sceneState.temperature);
            const productLabel = productType === 'small' ? 'Small' : 'Large';
            const radiationLabel = radiationState === 'enhance' ? 'Enhanced' : radiationState === 'weaken' ? 'Reduced' : 'Stable';
            badge.textContent = `${Number.isFinite(temp) ? `${temp.toFixed(0)}℃` : 'Kiln Twin'} | ${productLabel} | ${radiationLabel}`;
        }

        function applySceneStateDatasets() {
            Object.entries(state.sceneState || {}).forEach(([key, value]) => {
                if (value == null) return;
                hooks.root.dataset[key] = String(value);
            });
        }

        function sceneStateSignature(sceneState) {
            const source = sceneState || {};
            return JSON.stringify([
                source.mode || '',
                source.sceneKey || '',
                source.productType || source.product_type || '',
                source.temp ?? source.temperature ?? '',
                source.radiation_state || source.radiationState || source.trend || '',
            ]);
        }

        function syncSceneStateFromRuntime() {
            const nextState = resolveRuntimeSceneState(config, state.sceneState);
            const changed = sceneStateSignature(nextState) !== sceneStateSignature(state.sceneState);
            state.sceneState = {
                ...state.sceneState,
                ...nextState,
            };
            applySceneStateDatasets();
            return changed;
        }

        function setDatasetState() {
            hooks.root.dataset.kilnTwinMode = state.mode;
            hooks.root.dataset.kilnTwinReady = state.lifecycle === 'ready' || state.lifecycle === 'playing' || state.lifecycle === 'paused' || state.lifecycle === 'connected'
                ? 'true'
                : 'false';
            hooks.root.dataset.kilnTwinLifecycle = state.lifecycle;
            hooks.stage.dataset.kilnTwinReady = hooks.root.dataset.kilnTwinReady;
            hooks.stage.dataset.kilnTwinLifecycle = state.lifecycle;
        }

        function updateStatus(text, tone) {
            if (hooks.statusPill && typeof text === 'string' && text.trim()) {
                hooks.statusPill.textContent = text.trim();
            }
            if (hooks.statusPill && typeof tone === 'string' && tone.trim()) {
                hooks.statusPill.dataset.tone = tone.trim();
            }
            return hooks.statusPill;
        }

        function createInfoRow(labelText, valueText) {
            const row = createElement('div', 'kiln-twin-info-row');
            const label = createElement('span', 'kiln-twin-info-row__label', labelText);
            const value = createElement('span', 'kiln-twin-info-row__value', valueText || '--');
            row.append(label, value);
            return { row, value };
        }

        function createSidebarMetricCard(labelText, valueText, noteText) {
            const card = createElement('article', 'kiln-twin-side-metric');
            const label = createElement('div', 'kiln-twin-side-metric__label', labelText);
            const value = createElement('div', 'kiln-twin-side-metric__value', valueText || '--');
            const note = createElement('div', 'kiln-twin-side-metric__note', noteText || '--');
            card.append(label, value, note);
            return { card, value, note };
        }

        function buildUi() {
            const overview = createElement('div', 'kiln-twin-summary');
            const overviewTitle = createElement('div', 'kiln-twin-section-title', 'Twin Overview');
            const sceneRow = createInfoRow('Current Scene', 'Waiting');
            const moduleRow = createInfoRow('Current Module', 'Pending');
            const transportRow = createInfoRow('Run State', 'Idle');
            const telemetryRow = createInfoRow('Telemetry', 'Awaiting Input');
            const note = createElement('div', 'kiln-twin-note', 'The left side keeps only a summary and two secondary parameter cards.');
            overview.append(overviewTitle, sceneRow.row, moduleRow.row, transportRow.row, telemetryRow.row, note);

            const metricsMount = createElement('div', 'kiln-twin-dashboard-slot');

            const inspector = createElement('div', 'kiln-twin-controls');
            const inspectorTitle = createElement('div', 'kiln-twin-section-title', 'Secondary Parameters');
            const sidebarMetricGrid = createElement('div', 'kiln-twin-side-metrics');
            const productCard = createSidebarMetricCard('Product', '--', 'Loading and specification');
            const emissionCard = createSidebarMetricCard('Emissions', '--', 'Pollution reduction');
            sidebarMetricGrid.append(
                productCard.card,
                emissionCard.card
            );

            const focusRow = createInfoRow('Focus Layer', 'All Layers');
            const modeRow = createInfoRow('View Mode', state.mode === 'split' ? 'Split View' : state.mode === 'twin' ? 'Twin View' : 'Compatibility View');
            const orbitHintRow = createInfoRow('3D Navigation', 'Drag to rotate / scroll to zoom');
            inspector.append(
                inspectorTitle,
                sidebarMetricGrid,
                focusRow.row,
                modeRow.row,
                orbitHintRow.row
            );

            instance.mountPanel('overview', overview);
            instance.mountPanel('metrics', metricsMount);
            instance.mountPanel('inspector', inspector);

            metricsMount.addEventListener('click', (event) => {
                const card = event.target?.closest?.('.kiln-dashboard__card[data-module-key]');
                const moduleKey = String(card?.dataset?.moduleKey || '').trim();
                if (!moduleKey || moduleKey !== state.selectedPanelKey) return;
                event.preventDefault();
                if (typeof event.stopImmediatePropagation === 'function') {
                    event.stopImmediatePropagation();
                }
                event.stopPropagation();
                clearPanelSelection({
                    syncDashboard: true,
                    syncFocus: true,
                });
            }, true);

            if (!runtime.toolbarBound) {
                hooks.toolbarReset?.addEventListener('click', () => {
                    instance.setSceneState(resolveRuntimeSceneState(config, config.sceneState));
                    instance.applyScenePreview('toolbar-reset');
                    if (typeof runtime.scene?.resetView === 'function') {
                        runtime.scene.resetView();
                    } else {
                        runtime.scene?.fitToViewport?.({ immediate: true, resetOrbit: true });
                    }
                });
                hooks.toolbarPlayback?.addEventListener('click', () => {
                    const controllerState = runtime.controller?.getState?.() || {};
                    if (!runtime.controller) return;
                    if (controllerState.isPlaying) {
                        instance.pause();
                        return;
                    }
                    instance.play();
                });
                Object.entries(hooks.toolbarModes || {}).forEach(([mode, button]) => {
                    if (!button) return;
                    button.addEventListener('click', () => {
                        instance.setMode(mode);
                    });
                });
                runtime.toolbarBound = true;
            }

            return {
                summary: {
                    scene: sceneRow.value,
                    module: moduleRow.value,
                    transport: transportRow.value,
                    telemetry: telemetryRow.value,
                    note,
                },
                metricsMount,
                controls: {
                    focusValue: focusRow.value,
                    productValue: productCard.value,
                    productNote: productCard.note,
                    emissionValue: emissionCard.value,
                    emissionNote: emissionCard.note,
                    modeValue: modeRow.value,
                    orbitHint: orbitHintRow.value,
                },
            };
        }

        function updateEnvironmentBar(payload) {
            const telemetry = normalizeTelemetryPayload(payload);
            const temp = Number(telemetry.temp ?? telemetry.temperature);
            const efficiency = Number(telemetry.efficiency);
            const radiation = normalizeRadiationState(telemetry.radiation_state, state.sceneState.trend);
            const stamp = telemetry.timestamp ?? payload?.timestamp ?? state.lastTelemetry?.timestamp ?? Date.now();

            if (hooks.envTime) {
                hooks.envTime.textContent = formatShortTime(stamp);
            }
            if (hooks.envAmbient) {
                hooks.envAmbient.textContent = Number.isFinite(temp)
                    ? `${temp.toFixed(0)}℃`
                    : `${DEFAULT_TELEMETRY.temp}℃`;
            }
            if (hooks.envHumidity) {
                hooks.envHumidity.textContent = Number.isFinite(efficiency)
                    ? `${efficiency.toFixed(1)}%`
                    : `${DEFAULT_TELEMETRY.efficiency}%`;
            }
            if (hooks.envConnection) {
                hooks.envConnection.textContent = radiation === 'enhance' ? 'Enhanced' : radiation === 'weaken' ? 'Reduced' : 'Stable';
                hooks.envConnection.parentElement?.setAttribute(
                    'data-accent',
                    radiation === 'enhance' ? 'warning' : radiation === 'weaken' ? 'cyan' : 'active'
                );
            }
        }

        function syncDashboardSelection(moduleKey) {
            if (!runtime.dashboard?.selectModule || !moduleKey) return null;
            runtime.syncingDashboardSelection = true;
            try {
                return runtime.dashboard.selectModule(moduleKey);
            } finally {
                runtime.syncingDashboardSelection = false;
            }
        }

        function clearDashboardSelectionVisuals() {
            if (!runtime.ui?.metricsMount) return;
            runtime.ui.metricsMount
                .querySelectorAll('.kiln-dashboard__card[data-module-key]')
                .forEach((card) => {
                    delete card.dataset.selected;
                    card.setAttribute('aria-pressed', 'false');
                });
            const dashboardRoot = runtime.ui.metricsMount.querySelector('.kiln-dashboard');
            if (dashboardRoot) {
                delete dashboardRoot.dataset.selectedModule;
            }
        }

        function setSceneFocusLayer(focusLayerKey) {
            const normalized = normalizeFocusLayerKey(focusLayerKey);
            state.focusLayerKey = normalized;
            if (typeof runtime.scene?.setFocusLayer !== 'function') {
                return normalized;
            }
            try {
                return runtime.scene.setFocusLayer(normalized);
            } catch (error) {
                console.warn('[KilnTwinBoot] setFocusLayer failed', error);
                return null;
            }
        }

        function applyFocusLayer(panelKey) {
            return setSceneFocusLayer(panelKey);
        }

        function clearPanelSelection(options) {
            const settings = {
                syncDashboard: true,
                syncFocus: true,
                ...(options || {}),
            };

            state.selectedPanelKey = null;
            state.selectedPanelLabel = null;

            if (settings.syncDashboard) {
                clearDashboardSelectionVisuals();
            }
            if (settings.syncFocus !== false) {
                setSceneFocusLayer('all');
            }

            updateUiFromState();
            return {
                moduleKey: null,
                label: null,
                focusLayerKey: state.focusLayerKey,
            };
        }

        function handlePanelSelection(detail, options) {
            const settings = {
                syncDashboard: false,
                syncFocus: true,
                ...(options || {}),
            };
            const moduleKey = String(detail?.moduleKey || '').trim();
            if (!moduleKey) return null;

            state.selectedPanelKey = moduleKey;
            state.selectedPanelLabel = detail?.label || getPanelLabel(moduleKey);

            if (settings.syncDashboard) {
                syncDashboardSelection(moduleKey);
            }
            if (settings.syncFocus !== false) {
                applyFocusLayer(moduleKey);
            }

            updateUiFromState();
            return {
                moduleKey,
                label: state.selectedPanelLabel,
                focusLayerKey: state.focusLayerKey,
            };
        }

        function updateControlState() {
            if (!runtime.ui) return;
            const controllerState = runtime.controller?.getState?.() || {};
            const ready = !!runtime.controller && !controllerState.destroyed;
            const isPlaying = !!controllerState.isPlaying;

            if (hooks.toolbarPlayback) {
                hooks.toolbarPlayback.disabled = !ready;
                hooks.toolbarPlayback.dataset.state = isPlaying ? 'playing' : 'paused';
                const label = hooks.toolbarPlayback.querySelector('.kiln-twin-toolbar__label');
                const hint = hooks.toolbarPlayback.querySelector('.kiln-twin-toolbar__hint');
                if (label) label.textContent = isPlaying ? 'Pause' : 'Start';
                if (hint) hint.textContent = ready ? (isPlaying ? 'Telemetry live' : 'Controller ready') : 'Waiting for twin startup';
            }

            Object.entries(hooks.toolbarModes || {}).forEach(([mode, button]) => {
                if (!button) return;
                const active = state.mode === mode;
                button.dataset.active = active ? 'true' : 'false';
                button.setAttribute('aria-pressed', active ? 'true' : 'false');
            });
        }

        function updateModuleOptions() {
            return state.moduleList;
        }

        function updateTelemetrySummary(payload) {
            if (!runtime.ui) return;
            const telemetry = payload?.telemetry || payload || {};
            const temp = Number(telemetry.temp);
            const efficiency = Number(telemetry.efficiency);
            const productType = normalizeProductType(telemetry.product_type, state.sceneState.productType);
            const radiation = normalizeRadiationState(telemetry.radiation_state, state.sceneState.trend);
            const pollutionDrop = Number(telemetry.emissions?.pollutionDrop ?? telemetry.pollutionDrop ?? telemetry.pollution_drop);
            const nox = Number(telemetry.emissions?.NOx ?? telemetry.emissions?.nox);
            const co2 = Number(telemetry.emissions?.CO2 ?? telemetry.emissions?.co2);
            const productLabel = productType === 'small' ? 'Small' : 'Large';
            const productCount = Number(telemetry.productCount ?? telemetry.product_count);
            runtime.ui.summary.telemetry.textContent = Number.isFinite(temp)
                ? `${temp.toFixed(0)}℃ | ${Number.isFinite(efficiency) ? efficiency.toFixed(1) : '--'}%`
                : 'Awaiting input';
            runtime.ui.summary.scene.textContent = `${productLabel} | ${radiation === 'enhance' ? 'Enhanced' : radiation === 'weaken' ? 'Reduced' : 'Stable'}`;
            runtime.ui.controls.productValue.textContent = productLabel;
            runtime.ui.controls.productNote.textContent = [
                Number.isFinite(productCount) ? `${Math.round(productCount)} units` : null,
                Number.isFinite(telemetry.sizeRatio) ? `Size ratio ${Number(telemetry.sizeRatio).toFixed(3)}x` : null,
            ].filter(Boolean).join(' / ') || 'Loading and specification';
            runtime.ui.controls.emissionValue.textContent = Number.isFinite(pollutionDrop) ? `${pollutionDrop.toFixed(0)}%` : '--';
            runtime.ui.controls.emissionNote.textContent = [
                Number.isFinite(nox) ? `NOx ${nox.toFixed(0)} ppm` : null,
                Number.isFinite(co2) ? `CO2 ${co2.toFixed(0)} ppm` : null,
            ].filter(Boolean).join(' / ') || 'Pollution reduction';
            updateEnvironmentBar(payload);
        }

        function updateUiFromState() {
            if (!runtime.ui) return;
            runtime.ui.summary.module.textContent = state.moduleLabel
                ? state.moduleLabel
                : (state.moduleKey ? getPanelLabel(state.moduleKey) : 'Pending');
            runtime.ui.summary.transport.textContent = formatStatusText(state.lifecycle, state.statusDetail);
            runtime.ui.summary.note.textContent = state.bootError
                ? `Switched to compatibility mode: ${toText(state.bootError.message, 'Twin startup failed.')}`
                : '';
            runtime.ui.controls.focusValue.textContent = state.selectedPanelLabel
                ? state.selectedPanelLabel
                : 'All Layers';
            runtime.ui.controls.modeValue.textContent = state.mode === 'split' ? 'Split View' : state.mode === 'twin' ? 'Twin View' : 'Compatibility View';
            runtime.ui.controls.orbitHint.textContent = runtime.scene
                ? 'Drag to rotate / scroll to zoom'
                : 'Twin view offline';
            updateModuleOptions();
            updateControlState();
            updateCss2dBadge();
        }

        function applyScenePreview(reason) {
            syncSceneStateFromRuntime();
            const previewPayload = mergeTelemetryWithSceneState(state.lastTelemetry, state.sceneState, state.lastTelemetry);
            const scenePayload = previewPayload.telemetry;
            if (runtime.scene?.updateTelemetry) runtime.scene.updateTelemetry(scenePayload);
            if (runtime.overlays?.updateTelemetry) runtime.overlays.updateTelemetry(previewPayload);
            if (runtime.dashboard?.updateTelemetry) runtime.dashboard.updateTelemetry(previewPayload);
            state.lastTelemetry = clone(previewPayload);
            updateTelemetrySummary(previewPayload);
            updateCss2dBadge();
            if (reason) updateUiFromState();
            return previewPayload;
        }

        function destroyRuntime() {
            if (runtime.sceneStateSyncTimer != null) {
                global.clearInterval(runtime.sceneStateSyncTimer);
                runtime.sceneStateSyncTimer = null;
            }
            const controller = runtime.controller;
            if (controller?.destroy) {
                try {
                    controller.destroy();
                } catch (error) {
                    console.warn('[KilnTwinBoot] controller destroy failed', error);
                }
            }
            if (global.__kilnTwinController === controller) {
                global.__kilnTwinController = null;
            }
            ['scene', 'overlays', 'dashboard'].forEach((key) => {
                const entry = runtime[key];
                if (entry?.dispose) {
                    try {
                        entry.dispose();
                    } catch (error) {
                        console.warn(`[KilnTwinBoot] ${key} dispose failed`, error);
                    }
                }
                runtime[key] = null;
            });
            runtime.controller = null;
        }

        function resolveLiveModePreference() {
            if (state.hasUserModeOverride) {
                return state.preferredMode;
            }
            if (state.preferredMode && state.preferredMode !== 'legacy') {
                return state.preferredMode;
            }
            return sanitizeMode(config.liveMode || 'split');
        }

        async function startTwin() {
            if (runtime.destroyed) return instance;
            if (runtime.startPromise) return runtime.startPromise;

            runtime.startPromise = (async () => {
                state.lifecycle = 'loading';
                state.bootError = null;
                setDatasetState();
                updateStatus(formatStatusText('loading'), toneForStatus('loading'));
                runtime.ui = buildUi();
                updateUiFromState();
                applyScenePreview('initial-preview');

                const loaded = await loadDependencySet(config);
                runtime.modules = loaded;
                if (loaded.errors.length) {
                    console.warn('[KilnTwinBoot] Some twin dependencies failed to load.', loaded.errors);
                }

                if (loaded.scene) {
                    try {
                        runtime.scene = loaded.scene({
                            mount: hooks.scene,
                            telemetry: deriveTelemetryFromSceneState(state.sceneState, state.lastTelemetry).telemetry,
                        });
                    } catch (error) {
                        console.warn('[KilnTwinBoot] createKilnScene failed', error);
                    }
                }

                if (loaded.overlays) {
                    try {
                        runtime.overlays = loaded.overlays({
                            mount: hooks.ui,
                        });
                    } catch (error) {
                        console.warn('[KilnTwinBoot] createKilnOverlays failed', error);
                    }
                }

                if (loaded.dashboard) {
                    try {
                        runtime.dashboard = loaded.dashboard({
                            mount: runtime.ui.metricsMount,
                            eventTarget: hooks.root,
                            selectEventName: DEFAULT_EVENT_NAMES.dashboardSelect,
                            onModuleSelect(moduleKey, detail) {
                                if (runtime.syncingDashboardSelection) return;
                                handlePanelSelection({
                                    moduleKey,
                                    ...(detail || {}),
                                }, {
                                    syncDashboard: false,
                                    syncFocus: true,
                                });
                            },
                        });
                    } catch (error) {
                        console.warn('[KilnTwinBoot] createKilnDashboard failed', error);
                    }
                }

                if (!runtime.scene || !runtime.overlays || !runtime.dashboard || !loaded.controller?.create) {
                    state.lifecycle = 'error';
                    state.bootError = new Error('Twin modules unavailable, legacy fallback retained.');
                    setDatasetState();
                    updateStatus(formatStatusText('error'), toneForStatus('error'));
                    updateUiFromState();
                    applyScenePreview('fallback-preview');
                    return instance;
                }

                const mockCatalog = global.KilnTwinTelemetryMock?.getCatalog?.() || null;
                runtime.controller = loaded.controller.create({
                    eventTarget: hooks.root,
                    transport: {
                        type: 'mock',
                        autoPlay: config.autoPlay !== false,
                        intervalMs: config.intervalMs || 1500,
                        ...(Array.isArray(mockCatalog?.modules)
                            ? {
                                modules: mockCatalog.modules,
                                moduleKey: mockCatalog.default_module || mockCatalog.defaultModule || mockCatalog.modules[0]?.key || null,
                                url: '',
                            }
                            : {}),
                        ...(config.transport || {}),
                    },
                    onTelemetry(payload, detail) {
                        const effectivePayload = mergeTelemetryWithSceneState(payload, resolveRuntimeSceneState(config, state.sceneState), state.lastTelemetry || payload);
                        state.sceneState = resolveRuntimeSceneState(config, state.sceneState);
                        applySceneStateDatasets();
                        state.lastTelemetry = clone(effectivePayload);
                        state.moduleKey = detail?.moduleKey || state.moduleKey;
                        state.moduleLabel = detail?.moduleLabel || state.moduleLabel;
                        if (runtime.scene?.updateTelemetry) runtime.scene.updateTelemetry(effectivePayload.telemetry || effectivePayload);
                        if (runtime.overlays?.updateTelemetry) runtime.overlays.updateTelemetry(effectivePayload);
                        if (runtime.dashboard?.updateTelemetry) runtime.dashboard.updateTelemetry(effectivePayload);
                        updateTelemetrySummary(effectivePayload);
                        updateCss2dBadge();
                        updateUiFromState();
                    },
                    onStatusChange(detail) {
                        state.statusDetail = clone(detail);
                        state.lifecycle = detail?.reason || state.lifecycle;
                        if (state.lifecycle === 'connected' || state.lifecycle === 'playing' || state.lifecycle === 'paused') {
                            const liveMode = resolveLiveModePreference();
                            instance.setMode(liveMode, { persist: false });
                        } else if (state.lifecycle === 'error') {
                            instance.setMode('legacy', { persist: false });
                        }
                        updateStatus(formatStatusText(state.lifecycle, detail), toneForStatus(state.lifecycle));
                        setDatasetState();
                        updateUiFromState();
                    },
                    onModuleChange(detail) {
                        state.moduleKey = detail?.moduleKey || state.moduleKey;
                        state.moduleLabel = detail?.moduleLabel || state.moduleLabel;
                        state.moduleList = Array.isArray(detail?.modules) ? clone(detail.modules) : state.moduleList;
                        updateUiFromState();
                    },
                });

                global.__kilnTwinController = runtime.controller;
                state.moduleList = runtime.controller.listModules?.() || [];
                updateUiFromState();
                applyScenePreview('module-ready');
                if (runtime.sceneStateSyncTimer == null) {
                    runtime.sceneStateSyncTimer = global.setInterval(() => {
                        if (runtime.destroyed) return;
                        if (syncSceneStateFromRuntime()) {
                            applyScenePreview('page-scene-sync');
                        }
                    }, Math.max(120, Number(config.sceneStatePollMs) || 250));
                }

                try {
                    await runtime.controller.connect();
                    state.moduleList = runtime.controller.listModules?.() || state.moduleList;
                    state.lifecycle = runtime.controller.getState?.().isPlaying ? 'playing' : 'ready';
                    const liveMode = resolveLiveModePreference();
                    instance.setMode(liveMode, { persist: false });
                    updateStatus(formatStatusText(state.lifecycle), toneForStatus(state.lifecycle));
                    setDatasetState();
                    updateUiFromState();
                } catch (error) {
                    console.warn('[KilnTwinBoot] controller connect failed', error);
                    state.lifecycle = 'error';
                    state.bootError = error;
                    instance.setMode('legacy', { persist: false });
                    updateStatus(formatStatusText('error'), toneForStatus('error'));
                    setDatasetState();
                    updateUiFromState();
                    applyScenePreview('connect-error');
                }

                syncShellLayout();
                return instance;
            })();

            return runtime.startPromise;
        }

        const instance = {
            version: VERSION,
            config,
            getHooks() {
                return {
                    ...hooks,
                    slots: { ...hooks.slots },
                };
            },
            getState() {
                return {
                    mode: state.mode,
                    preferredMode: state.preferredMode,
                    lifecycle: state.lifecycle,
                    sceneState: { ...state.sceneState },
                    moduleKey: state.moduleKey,
                    moduleLabel: state.moduleLabel,
                    selectedPanelKey: state.selectedPanelKey,
                    selectedPanelLabel: state.selectedPanelLabel,
                    focusLayerKey: state.focusLayerKey,
                    modules: clone(state.moduleList),
                    lastTelemetry: clone(state.lastTelemetry),
                    bootError: state.bootError ? toText(state.bootError.message, 'Twin startup failed.') : null,
                };
            },
            whenReady() {
                return startTwin();
            },
            setMode(nextMode, options) {
                const settings = {
                    persist: true,
                    ...(options || {}),
                };
                const normalized = sanitizeMode(nextMode);
                state.mode = normalized;
                if (settings.persist !== false) {
                    state.preferredMode = normalized;
                    state.hasUserModeOverride = true;
                }
                setDatasetState();
                updateControlState();
                updateUiFromState();
                return state.mode;
            },
            setSceneState(nextState) {
                if (!nextState || typeof nextState !== 'object') return this.getState().sceneState;
                state.sceneState = {
                    ...state.sceneState,
                    ...resolveRuntimeSceneState(config, nextState),
                };
                applySceneStateDatasets();
                updateUiFromState();
                applyScenePreview('scene-state');
                return { ...state.sceneState };
            },
            applyScenePreview(reason) {
                return applyScenePreview(reason);
            },
            applyTelemetry(payload, options) {
                if (runtime.controller?.applyTelemetry) {
                    return runtime.controller.applyTelemetry(payload, options);
                }
                state.lastTelemetry = clone(payload);
                if (runtime.scene?.updateTelemetry) runtime.scene.updateTelemetry(payload?.telemetry || payload);
                if (runtime.overlays?.updateTelemetry) runtime.overlays.updateTelemetry(payload);
                if (runtime.dashboard?.updateTelemetry) runtime.dashboard.updateTelemetry(payload);
                updateTelemetrySummary(payload);
                updateCss2dBadge();
                return clone(payload);
            },
            play() {
                if (!runtime.controller?.play) return false;
                const result = runtime.controller.play();
                updateControlState();
                return result;
            },
            pause() {
                if (!runtime.controller?.pause) return false;
                const result = runtime.controller.pause();
                updateControlState();
                return result;
            },
            setModule(moduleKey) {
                if (!runtime.controller?.setModule) return null;
                const resume = runtime.controller.getState?.().isPlaying;
                const result = runtime.controller.setModule(moduleKey, {
                    emit: true,
                    resume,
                    reason: 'boot-set-module',
                });
                state.moduleList = runtime.controller.listModules?.() || state.moduleList;
                state.moduleKey = result?.moduleKey || state.moduleKey;
                state.moduleLabel = result?.moduleLabel || state.moduleLabel;
                updateUiFromState();
                return result;
            },
            setStatus(text, tone) {
                return updateStatus(text, tone);
            },
            selectPanel(panelKey, options) {
                return handlePanelSelection({
                    moduleKey: panelKey,
                    label: getPanelLabel(panelKey),
                }, {
                    syncDashboard: true,
                    syncFocus: true,
                    ...(options || {}),
                });
            },
            getSlot(name) {
                return hooks.slots[name] || null;
            },
            mountPanel(name, content, options) {
                const settings = {
                    replace: true,
                    ...(options || {}),
                };
                const target = hooks.slots[name];
                if (!target) return null;
                if (settings.replace) {
                    target.replaceChildren();
                }
                appendContent(target, content);
                target.dataset.kilnTwinSlotState = 'filled';
                scheduleLayoutSync(syncShellLayout);
                return target;
            },
            clearPanel(name) {
                const target = hooks.slots[name];
                if (!target) return null;
                target.replaceChildren();
                delete target.dataset.kilnTwinSlotState;
                scheduleLayoutSync(syncShellLayout);
                return target;
            },
            dispose() {
                runtime.destroyed = true;
                runtime.resizeObserver?.disconnect();
                runtime.resizeObserver = null;
                destroyRuntime();
                if (hooks.css2d) hooks.css2d.replaceChildren();
                hooks.root.dataset.kilnTwinReady = 'false';
                hooks.root.dataset.kilnTwinLifecycle = 'destroyed';
                hooks.stage.dataset.kilnTwinReady = 'false';
                hooks.stage.dataset.kilnTwinLifecycle = 'destroyed';
                if (global.__kilnTwinBoot === instance) {
                    global.__kilnTwinBoot = null;
                }
                updateStatus('Twin stopped', 'neutral');
                return true;
            },
        };

        hooks.root.dataset.kilnTwinReady = 'false';
        hooks.root.dataset.kilnTwinMode = state.mode;
        hooks.root.dataset.kilnTwinLifecycle = state.lifecycle;
        hooks.stage.dataset.kilnTwinReady = 'false';
        hooks.stage.dataset.kilnTwinLifecycle = state.lifecycle;

        if (hooks.panelTitle && typeof config.panelTitleText === 'string' && config.panelTitleText.trim()) {
            hooks.panelTitle.textContent = config.panelTitleText.trim();
        }
        if (hooks.panelSubtitle && typeof config.panelSubtitleText === 'string' && config.panelSubtitleText.trim()) {
            hooks.panelSubtitle.textContent = config.panelSubtitleText.trim();
        }

        updateStatus(config.statusText || 'Compatibility mode', config.statusTone || 'neutral');
        updateEnvironmentBar({
            timestamp: Date.now(),
            ...DEFAULT_TELEMETRY,
        });
        instance.setSceneState(state.sceneState);

        if (typeof global.ResizeObserver === 'function') {
            runtime.resizeObserver = new global.ResizeObserver(() => syncShellLayout());
            runtime.resizeObserver.observe(hooks.viewport);
            runtime.resizeObserver.observe(hooks.sidePanel);
        }

        scheduleLayoutSync(syncShellLayout);
        global.__kilnTwinBoot = instance;
        if (config.autoStart !== false) {
            startTwin().catch((error) => {
                console.warn('[KilnTwinBoot] async start failed', error);
                state.lifecycle = 'error';
                state.bootError = error;
                instance.setMode('legacy', { persist: false });
                updateStatus(formatStatusText('error'), toneForStatus('error'));
                setDatasetState();
                updateUiFromState();
            });
        }
        return instance;
    }

    function init(options) {
        const config = {
            ...DEFAULT_IDS,
            mode: 'legacy',
            sceneState: {},
            sceneStatePollMs: 250,
            getSceneState: null,
            statusText: 'Compatibility mode',
            statusTone: 'neutral',
            panelTitleText: '',
            panelSubtitleText: '',
            syncLayout: null,
            autoStart: true,
            autoPlay: true,
            liveMode: 'twin',
            transport: {},
            urls: {},
            ...(options || {}),
        };

        if (global.__kilnTwinBoot && typeof global.__kilnTwinBoot.dispose === 'function') {
            global.__kilnTwinBoot.dispose();
        }

        return createInstance(config);
    }

    global.KilnTwinBoot = {
        version: VERSION,
        init,
        getInstance() {
            return global.__kilnTwinBoot || null;
        },
    };
}(window));
