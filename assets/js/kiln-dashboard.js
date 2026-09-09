(function (global) {
    'use strict';

    const SCRIPT_URL = global.document?.currentScript?.src || '';
    const DEFAULTS = {
        mount: 'kiln-twin-side-panel',
        eventTarget: null,
        onModuleSelect: null,
        selectEventName: 'kiln:dashboard:module-select',
        historyLimit: 24,
    };
    const TARGET_TEMP = 1225;
    const SVG_NS = 'http://www.w3.org/2000/svg';

    function resolveMount(input, fallbackId) {
        if (input && typeof input === 'object' && input.nodeType === 1) return input;
        if (typeof input === 'string' && input) {
            return global.document.getElementById(input) || global.document.querySelector(input);
        }
        if (fallbackId) return global.document.getElementById(fallbackId);
        return null;
    }

    function isPlainObject(value) {
        return Object.prototype.toString.call(value) === '[object Object]';
    }

    function clamp(value, min, max) {
        return Math.min(Math.max(value, min), max);
    }

    function round(value, digits) {
        const factor = Math.pow(10, digits);
        return Math.round(value * factor) / factor;
    }

    function toFiniteNumber(value, fallback) {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : fallback;
    }

    function firstDefined() {
        for (let index = 0; index < arguments.length; index += 1) {
            const value = arguments[index];
            if (value !== undefined && value !== null && value !== '') {
                return value;
            }
        }
        return undefined;
    }

    function normalizeRadiationState(value, temp, fallback) {
        const source = String(value || fallback || '').trim().toLowerCase();
        if (['enhance', 'enhanced', 'high', 'strong', 'inward', 'focus', 'boost'].includes(source)) return 'enhance';
        if (['weak', 'weaken', 'weakened', 'low', 'outward', 'bleed'].includes(source)) return 'weaken';
        if (['steady', 'stable', 'hold', 'balanced', 'normal'].includes(source)) return 'steady';
        if (Number.isFinite(temp) && temp >= 1200) return 'enhance';
        if (Number.isFinite(temp) && temp <= 1120) return 'weaken';
        return fallback || 'steady';
    }

    function normalizeProductType(value, temp, fallback) {
        const source = String(value || fallback || '').trim().toLowerCase();
        if (source === 'small') return 'small';
        if (source === 'large') return 'large';
        if (Number.isFinite(temp)) return temp >= 1210 ? 'small' : 'large';
        return fallback || 'large';
    }

    function normalizeTimestamp(value, fallback) {
        if (value == null || value === '') return fallback ?? null;
        if (value instanceof Date && !Number.isNaN(value.getTime())) return value.getTime();
        if (typeof value === 'number') return value < 1e12 ? value * 1000 : value;
        const parsed = Date.parse(value);
        return Number.isFinite(parsed) ? parsed : (fallback ?? null);
    }

    function formatTimestamp(value) {
        const timestamp = normalizeTimestamp(value, null);
        if (!Number.isFinite(timestamp)) return '--';
        return new Intl.DateTimeFormat(undefined, {
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: false,
        }).format(new Date(timestamp));
    }

    function deriveProductSizeRatio(temp, productType) {
        if (!Number.isFinite(temp)) return 1;
        const minTemp = 913;
        const maxTemp = 1361;
        const normalized = clamp((temp - minTemp) / (maxTemp - minTemp), 0, 1);
        const minScale = productType === 'large' ? 0.7 : 0.82;
        const maxScale = productType === 'large' ? 1.2 : 1.12;
        return round(maxScale + ((minScale - maxScale) * normalized), 3);
    }

    function derivePollutionDrop(emissions) {
        const co2 = Number(emissions?.CO2);
        const nox = Number(emissions?.NOx);
        if (!Number.isFinite(co2) || !Number.isFinite(nox)) return null;
        return round(clamp(100 - ((co2 / 6) + (nox * 1.4)), 0, 100), 1);
    }

    function deriveFlameProfile(temp, radiationState) {
        if (!Number.isFinite(temp)) {
            return { blueRatio: null, orangeRatio: null, intensity: null };
        }

        const bias = radiationState === 'enhance' ? 8 : radiationState === 'weaken' ? -10 : 0;
        const orangePercent = clamp(((temp - 1080) / 2.4) + bias, 0, 100);
        const bluePercent = 100 - orangePercent;
        return {
            blueRatio: round(bluePercent / 100, 3),
            orangeRatio: round(orangePercent / 100, 3),
            intensity: round(clamp((temp - 913) / (1361 - 913), 0, 1), 3),
        };
    }

    function cloneSerializable(value) {
        if (value == null) return value;
        try {
            return JSON.parse(JSON.stringify(value));
        } catch (error) {
            return value;
        }
    }

    function readHistoryCandidate(source) {
        if (!Array.isArray(source)) return null;
        const values = source.map((entry) => {
            if (Number.isFinite(Number(entry))) return Number(entry);
            if (isPlainObject(entry)) {
                return toFiniteNumber(firstDefined(entry.temp, entry.temperature, entry.value), NaN);
            }
            return NaN;
        }).filter((entry) => Number.isFinite(entry));
        return values.length ? values : null;
    }

    function normalizeHistory(payload, previousHistory, currentTemp, historyLimit) {
        const root = isPlainObject(payload) ? payload : {};
        const telemetryRoot = isPlainObject(root.telemetry) ? root.telemetry : root;
        const thermalRoot = isPlainObject(telemetryRoot.thermal)
            ? telemetryRoot.thermal
            : (isPlainObject(root.thermal) ? root.thermal : {});

        const explicitHistory = readHistoryCandidate(
            firstDefined(
                telemetryRoot.tempHistory,
                telemetryRoot.temperatureHistory,
                telemetryRoot.history,
                thermalRoot.tempHistory,
                thermalRoot.temperatureHistory,
                thermalRoot.history,
                root.tempHistory,
                root.temperatureHistory,
                root.history
            )
        );

        const values = explicitHistory ? explicitHistory.slice() : (Array.isArray(previousHistory) ? previousHistory.slice() : []);
        if (Number.isFinite(currentTemp) && (!values.length || values[values.length - 1] !== currentTemp)) {
            values.push(currentTemp);
        }
        return values.slice(-historyLimit);
    }

    function normalizeTelemetry(payload, previousTelemetry) {
        const previous = isPlainObject(previousTelemetry) ? previousTelemetry : {};
        const root = isPlainObject(payload) ? payload : {};
        const telemetryRoot = isPlainObject(root.telemetry) ? root.telemetry : root;
        const emissionsRoot = isPlainObject(telemetryRoot.emissions)
            ? telemetryRoot.emissions
            : (isPlainObject(root.emissions) ? root.emissions : {});
        const environmentRoot = isPlainObject(telemetryRoot.environment)
            ? telemetryRoot.environment
            : (isPlainObject(root.environment) ? root.environment : {});
        const flameRoot = isPlainObject(telemetryRoot.flame)
            ? telemetryRoot.flame
            : (isPlainObject(root.flame) ? root.flame : {});
        const productRoot = isPlainObject(telemetryRoot.product)
            ? telemetryRoot.product
            : (isPlainObject(root.product) ? root.product : {});
        const productSpecRoot = isPlainObject(telemetryRoot.productSpec)
            ? telemetryRoot.productSpec
            : (isPlainObject(root.productSpec) ? root.productSpec : {});

        const temp = toFiniteNumber(
            firstDefined(telemetryRoot.temp, telemetryRoot.temperature, root.temp, root.temperature, previous.temp),
            undefined
        );
        const productType = normalizeProductType(
            firstDefined(
                telemetryRoot.product_type,
                telemetryRoot.productType,
                typeof telemetryRoot.product === 'string' ? telemetryRoot.product : undefined,
                root.product_type,
                root.productType,
                typeof root.product === 'string' ? root.product : undefined,
                productRoot.type,
                productRoot.product_type,
                productSpecRoot.type,
                previous.productType
            ),
            temp,
            previous.productType
        );
        const radiationState = normalizeRadiationState(
            firstDefined(
                telemetryRoot.radiation_state,
                telemetryRoot.radiationState,
                telemetryRoot.radiation,
                root.radiation_state,
                root.radiationState,
                root.radiation,
                previous.radiationState
            ),
            temp,
            previous.radiationState || 'steady'
        );
        const productCount = toFiniteNumber(
            firstDefined(
                telemetryRoot.productCount,
                telemetryRoot.product_count,
                root.productCount,
                root.product_count,
                productRoot.count,
                productRoot.productCount,
                productSpecRoot.count,
                previous.productCount
            ),
            previous.productCount
        );
        const efficiency = toFiniteNumber(
            firstDefined(telemetryRoot.efficiency, root.efficiency, previous.efficiency),
            previous.efficiency
        );
        const co2 = toFiniteNumber(
            firstDefined(emissionsRoot.CO2, emissionsRoot.co2, previous.emissions?.CO2),
            previous.emissions?.CO2
        );
        const nox = toFiniteNumber(
            firstDefined(emissionsRoot.NOx, emissionsRoot.nox, previous.emissions?.NOx),
            previous.emissions?.NOx
        );
        const ambientTemp = toFiniteNumber(
            firstDefined(
                telemetryRoot.ambientTemp,
                telemetryRoot.ambient_temp,
                root.ambientTemp,
                root.ambient_temp,
                environmentRoot.ambientTemp,
                environmentRoot.ambient_temp,
                environmentRoot.temperature,
                previous.ambientTemp
            ),
            previous.ambientTemp
        );
        const humidity = toFiniteNumber(
            firstDefined(telemetryRoot.humidity, root.humidity, environmentRoot.humidity, previous.humidity),
            previous.humidity
        );
        const sizeRatio = toFiniteNumber(
            firstDefined(
                telemetryRoot.sizeRatio,
                telemetryRoot.size_ratio,
                root.sizeRatio,
                root.size_ratio,
                productRoot.sizeRatio,
                productRoot.size_ratio,
                productSpecRoot.sizeFactor,
                previous.sizeRatio
            ),
            previous.sizeRatio ?? deriveProductSizeRatio(temp, productType)
        );
        const timestamp = normalizeTimestamp(
            firstDefined(root.timestamp, telemetryRoot.timestamp, previous.timestamp),
            previous.timestamp ?? Date.now()
        );
        const derivedFlame = deriveFlameProfile(temp, radiationState);
        const blueRatio = toFiniteNumber(
            firstDefined(flameRoot.blueRatio, flameRoot.blue_ratio, previous.flame?.blueRatio),
            derivedFlame.blueRatio
        );
        const orangeRatio = toFiniteNumber(
            firstDefined(flameRoot.orangeRatio, flameRoot.orange_ratio, previous.flame?.orangeRatio),
            derivedFlame.orangeRatio
        );
        const intensity = toFiniteNumber(
            firstDefined(flameRoot.intensity, previous.flame?.intensity),
            derivedFlame.intensity
        );
        const pollutionDrop = toFiniteNumber(
            firstDefined(emissionsRoot.pollutionDrop, emissionsRoot.pollution_drop, previous.emissions?.pollutionDrop),
            derivePollutionDrop({ CO2: co2, NOx: nox })
        );

        return {
            temp,
            efficiency,
            productType,
            productCount,
            sizeRatio,
            radiationState,
            emissions: {
                CO2: co2,
                NOx: nox,
                pollutionDrop,
            },
            flame: {
                blueRatio,
                orangeRatio,
                intensity,
            },
            ambientTemp,
            humidity,
            timestamp,
        };
    }

    function deriveTrend(history) {
        if (!Array.isArray(history) || history.length < 2) {
            return { delta: null, label: '--', direction: 'flat' };
        }
        const latest = history[history.length - 1];
        const previous = history[Math.max(0, history.length - 4)];
        const delta = round(latest - previous, 1);
        if (Math.abs(delta) < 0.5) {
            return { delta, label: 'Flat', direction: 'flat' };
        }
        return {
            delta,
            label: delta > 0 ? `+${delta}℃` : `${delta}℃`,
            direction: delta > 0 ? 'up' : 'down',
        };
    }

    function deriveMetrics(telemetry, history) {
        const thermalHeadroom = Number.isFinite(telemetry.temp)
            ? round(clamp(100 - (Math.abs(telemetry.temp - TARGET_TEMP) * 0.75), 0, 100), 0)
            : null;
        const trend = deriveTrend(history);
        const radiationLabel = telemetry.radiationState === 'enhance'
            ? 'Enhanced Radiation'
            : telemetry.radiationState === 'weaken'
                ? 'Reduced Radiation'
                : 'Steady Radiation';
        const productLabel = telemetry.productType === 'small' ? 'Small Products' : 'Large Products';
        const flameState = Number.isFinite(telemetry.flame.orangeRatio)
            ? telemetry.flame.orangeRatio >= 0.36
                ? 'Orange Core Enhanced'
                : telemetry.flame.orangeRatio >= 0.16
                    ? 'Blue-Orange Transition'
                    : 'Blue Flame Stable'
            : '--';
        const pollutionTone = Number.isFinite(telemetry.emissions.pollutionDrop)
            ? telemetry.emissions.pollutionDrop >= 32
                ? 'Low Emissions'
                : telemetry.emissions.pollutionDrop >= 20
                    ? 'Controlled'
                    : 'Needs Optimization'
            : '--';
        const efficiencyTone = Number.isFinite(telemetry.efficiency)
            ? telemetry.efficiency >= 90
                ? 'High Efficiency'
                : telemetry.efficiency >= 85
                    ? 'Stable'
                    : 'Needs Optimization'
            : '--';

        return {
            thermalHeadroom,
            trend,
            radiationLabel,
            productLabel,
            flameState,
            pollutionTone,
            efficiencyTone,
            targetDelta: Number.isFinite(telemetry.temp) ? round(telemetry.temp - TARGET_TEMP, 0) : null,
        };
    }

    function createElement(tagName, className, text) {
        const element = global.document.createElement(tagName);
        if (className) element.className = className;
        if (text != null) element.textContent = text;
        return element;
    }

    function createSvgElement(tagName, attributes) {
        const element = global.document.createElementNS(SVG_NS, tagName);
        Object.entries(attributes || {}).forEach(([key, value]) => {
            element.setAttribute(key, String(value));
        });
        return element;
    }

    function createMetricRow(label) {
        const row = createElement('div', 'kiln-dashboard__metric');
        const labelNode = createElement('span', 'kiln-dashboard__metric-label', label);
        const valueNode = createElement('span', 'kiln-dashboard__metric-value', '--');
        row.append(labelNode, valueNode);
        return { row, valueNode };
    }

    function setText(node, value, fallback) {
        node.textContent = value == null || value === '' ? (fallback ?? '--') : String(value);
    }

    function formatNumber(value, digits) {
        return Number.isFinite(value) ? value.toFixed(digits) : '--';
    }

    function formatPercent(value, digits) {
        return Number.isFinite(value) ? `${value.toFixed(digits)}%` : '--';
    }

    function formatRatio(value) {
        return Number.isFinite(value) ? `${value.toFixed(3)}x` : '--';
    }

    function formatProductCount(value) {
        return Number.isFinite(value) ? `${Math.round(value)} units` : '--';
    }

    function renderSparkline(history, elements) {
        const values = Array.isArray(history) && history.length ? history : [0, 0];
        const width = 180;
        const height = 54;
        const padding = 4;
        const min = Math.min.apply(null, values);
        const max = Math.max.apply(null, values);
        const range = max - min || 1;

        const points = values.map((value, index) => {
            const x = padding + ((width - (padding * 2)) * (values.length === 1 ? 0 : index / (values.length - 1)));
            const y = height - padding - (((value - min) / range) * (height - (padding * 2)));
            return [round(x, 2), round(y, 2)];
        });

        const linePath = points.map((point, index) => `${index === 0 ? 'M' : 'L'} ${point[0]} ${point[1]}`).join(' ');
        const areaPath = `${linePath} L ${points[points.length - 1][0]} ${height - padding} L ${points[0][0]} ${height - padding} Z`;
        const lastPoint = points[points.length - 1];

        elements.area.setAttribute('d', areaPath);
        elements.line.setAttribute('d', linePath);
        elements.marker.setAttribute('cx', String(lastPoint[0]));
        elements.marker.setAttribute('cy', String(lastPoint[1]));
    }

    function ensureStylesheet() {
        const href = (() => {
            try {
                return SCRIPT_URL ? new URL('../css/kiln-dashboard.css', SCRIPT_URL).href : 'assets/css/kiln-dashboard.css';
            } catch (error) {
                return 'assets/css/kiln-dashboard.css';
            }
        })();

        const existing = global.document.querySelector(`link[data-kiln-dashboard-styles="true"], link[href="${href}"]`);
        if (existing) return existing;

        const link = global.document.createElement('link');
        link.rel = 'stylesheet';
        link.href = href;
        link.dataset.kilnDashboardStyles = 'true';
        global.document.head.appendChild(link);
        return link;
    }

    function dispatchSelection(target, eventName, detail) {
        if (!target || typeof target.dispatchEvent !== 'function' || typeof global.CustomEvent !== 'function') return;
        target.dispatchEvent(new global.CustomEvent(eventName, { detail }));
    }

    function createCard(moduleKey, kicker, title) {
        const card = createElement('button', 'kiln-dashboard__card');
        card.type = 'button';
        card.dataset.moduleKey = moduleKey;

        const head = createElement('div', 'kiln-dashboard__card-head');
        const badgeNode = createElement('span', 'kiln-dashboard__card-badge', '--');
        if (kicker) {
            const kickerNode = createElement('span', 'kiln-dashboard__card-kicker', kicker);
            head.appendChild(kickerNode);
        }
        head.appendChild(badgeNode);

        const titleNode = createElement('h3', 'kiln-dashboard__card-title', title);
        const primary = createElement('div', 'kiln-dashboard__primary');
        const primaryValue = createElement('span', 'kiln-dashboard__primary-value', '--');
        const primaryUnit = createElement('span', 'kiln-dashboard__primary-unit', '');
        primary.append(primaryValue, primaryUnit);

        const noteNode = createElement('div', 'kiln-dashboard__card-note', '--');
        const visual = createElement('div', 'kiln-dashboard__card-visual');
        const metrics = createElement('div', 'kiln-dashboard__metrics');

        card.append(head, titleNode, primary, noteNode, visual, metrics);

        return {
            card,
            badgeNode,
            primaryValue,
            primaryUnit,
            noteNode,
            visual,
            metrics,
        };
    }

    function createKilnDashboard(options) {
        ensureStylesheet();

        const settings = {
            ...DEFAULTS,
            ...(options || {}),
        };
        const mount = resolveMount(settings.mount, DEFAULTS.mount);

        if (!mount) {
            console.warn('[KilnDashboard] Mount container not found.');
            return {
                updateTelemetry() {
                    return null;
                },
                selectModule() {
                    return null;
                },
                dispose() {
                    return true;
                },
            };
        }

        mount.__kilnDashboardInstance?.dispose?.();

        const state = {
            telemetry: null,
            derived: null,
            history: [],
            selectedModuleKey: null,
            resizeObserver: null,
        };

        const root = createElement('section', 'kiln-dashboard');
        root.classList.add('kiln-dashboard--detail');
        const header = createElement('header', 'kiln-dashboard__header');
        const titleBlock = createElement('div', 'kiln-dashboard__header-copy');
        const eyebrow = createElement('div', 'kiln-dashboard__eyebrow', 'Kiln Digital Twin');
        const heading = createElement('h2', 'kiln-dashboard__heading', 'Detailed Parameters');
        titleBlock.append(eyebrow, heading);
        header.append(titleBlock);

        const grid = createElement('div', 'kiln-dashboard__grid');

        const tempCard = createCard('temperature', '', 'Temperature');
        tempCard.card.classList.add('kiln-dashboard__card--hero', 'kiln-dashboard__card--temperature');
        const tempSparkline = createElement('div', 'kiln-dashboard__sparkline');
        const tempSparkSvg = createSvgElement('svg', {
            class: 'kiln-dashboard__sparkline-svg',
            viewBox: '0 0 180 54',
            preserveAspectRatio: 'none',
        });
        const tempSparkArea = createSvgElement('path', { class: 'kiln-dashboard__sparkline-area' });
        const tempSparkLine = createSvgElement('path', { class: 'kiln-dashboard__sparkline-line' });
        const tempSparkMarker = createSvgElement('circle', { class: 'kiln-dashboard__sparkline-marker', r: '3.5' });
        tempSparkSvg.append(tempSparkArea, tempSparkLine, tempSparkMarker);
        tempSparkline.appendChild(tempSparkSvg);
        tempCard.visual.appendChild(tempSparkline);
        const tempRows = [
            createMetricRow('Radiation'),
            createMetricRow('Trend'),
            createMetricRow('Target Delta'),
        ];
        tempRows.forEach((row) => tempCard.metrics.appendChild(row.row));

        const efficiencyCard = createCard('efficiency', '', 'Efficiency');
        efficiencyCard.card.classList.add('kiln-dashboard__card--hero', 'kiln-dashboard__card--efficiency');
        const efficiencyBar = createElement('div', 'kiln-dashboard__meter');
        const efficiencyFill = createElement('span', 'kiln-dashboard__meter-fill');
        efficiencyBar.appendChild(efficiencyFill);
        efficiencyCard.visual.appendChild(efficiencyBar);
        const efficiencyRows = [
            createMetricRow('Thermal Efficiency'),
            createMetricRow('Thermal Headroom'),
            createMetricRow('Status'),
        ];
        efficiencyRows.forEach((row) => efficiencyCard.metrics.appendChild(row.row));

        const cardEntries = [
            { key: 'temperature', label: 'Temperature', refs: tempCard },
            { key: 'efficiency', label: 'Efficiency', refs: efficiencyCard },
        ];

        cardEntries.forEach((entry) => {
            entry.refs.card.addEventListener('click', () => {
                instance.selectModule(entry.key);
            });
            grid.appendChild(entry.refs.card);
        });

        root.append(header, grid);

        mount.replaceChildren(root);
        mount.classList.add('kiln-dashboard-host');

        function syncSelectedModule() {
            cardEntries.forEach((entry) => {
                const isSelected = entry.key === state.selectedModuleKey;
                entry.refs.card.dataset.selected = isSelected ? 'true' : 'false';
                entry.refs.card.setAttribute('aria-pressed', isSelected ? 'true' : 'false');
            });
            if (state.selectedModuleKey) {
                root.dataset.selectedModule = state.selectedModuleKey;
            } else {
                delete root.dataset.selectedModule;
            }
        }

        function applyResponsiveLayout(width) {
            const safeWidth = Math.max(0, Number(width) || mount.clientWidth || 0);
            root.dataset.layout = safeWidth < 300 ? 'stack' : 'dual';
            root.dataset.density = safeWidth < 360 ? 'compact' : 'regular';
        }

        function renderDashboard() {
            const telemetry = state.telemetry;
            const derived = state.derived;

            if (!telemetry || !derived) {
                delete root.dataset.radiationState;
                delete root.dataset.productType;

                [
                    tempCard,
                    efficiencyCard,
                ].forEach((card) => {
                    setText(card.primaryValue, '--');
                    setText(card.primaryUnit, '');
                    setText(card.badgeNode, '--');
                    setText(card.noteNode, 'Awaiting telemetry data');
                });

                renderSparkline([0, 0], {
                    area: tempSparkArea,
                    line: tempSparkLine,
                    marker: tempSparkMarker,
                });
                efficiencyFill.style.width = '0%';
                return;
            }

            root.dataset.radiationState = telemetry.radiationState;
            root.dataset.productType = telemetry.productType;

            setText(tempCard.badgeNode, derived.radiationLabel);
            setText(tempCard.primaryValue, formatNumber(telemetry.temp, 0));
            setText(tempCard.primaryUnit, '℃');
            setText(tempCard.noteNode, 'Current temperature, trend, and target deviation');
            tempRows[0].valueNode.textContent = derived.radiationLabel;
            tempRows[1].valueNode.textContent = derived.trend.label;
            tempRows[2].valueNode.textContent = Number.isFinite(derived.targetDelta)
                ? `${derived.targetDelta >= 0 ? '+' : ''}${derived.targetDelta.toFixed(0)}℃`
                : '--';
            renderSparkline(state.history, {
                area: tempSparkArea,
                line: tempSparkLine,
                marker: tempSparkMarker,
            });

            setText(efficiencyCard.badgeNode, derived.efficiencyTone);
            setText(efficiencyCard.primaryValue, formatNumber(telemetry.efficiency, 1));
            setText(efficiencyCard.primaryUnit, '%');
            setText(efficiencyCard.noteNode, 'Thermal efficiency, headroom, and status');
            efficiencyRows[0].valueNode.textContent = formatPercent(telemetry.efficiency, 1);
            efficiencyRows[1].valueNode.textContent = formatPercent(derived.thermalHeadroom, 0);
            efficiencyRows[2].valueNode.textContent = derived.efficiencyTone;
            efficiencyFill.style.width = `${clamp(toFiniteNumber(telemetry.efficiency, 0), 0, 100)}%`;
        }

        const instance = {
            updateTelemetry(payload) {
                if (payload == null && !state.telemetry) {
                    renderDashboard();
                    return { telemetry: null, derived: null };
                }

                const telemetry = normalizeTelemetry(payload, state.telemetry);
                const history = normalizeHistory(payload, state.history, telemetry.temp, settings.historyLimit);
                const derived = deriveMetrics(telemetry, history);

                state.telemetry = telemetry;
                state.history = history;
                state.derived = derived;

                renderDashboard();

                return {
                    telemetry: cloneSerializable({
                        ...telemetry,
                        history: history.slice(),
                    }),
                    derived: cloneSerializable(derived),
                };
            },
            selectModule(moduleKey) {
                const entry = cardEntries.find((item) => item.key === moduleKey);
                if (!entry) return null;

                state.selectedModuleKey = moduleKey;
                syncSelectedModule();

                const detail = {
                    moduleKey: entry.key,
                    label: entry.label,
                    telemetry: cloneSerializable(state.telemetry ? { ...state.telemetry, history: state.history.slice() } : null),
                    derived: cloneSerializable(state.derived),
                    source: 'kiln-dashboard',
                };

                if (typeof settings.onModuleSelect === 'function') {
                    settings.onModuleSelect(entry.key, detail);
                }

                dispatchSelection(mount, settings.selectEventName, detail);
                if (settings.eventTarget && settings.eventTarget !== mount) {
                    dispatchSelection(settings.eventTarget, settings.selectEventName, detail);
                }

                return detail;
            },
            getState() {
                return {
                    telemetry: cloneSerializable(state.telemetry ? { ...state.telemetry, history: state.history.slice() } : null),
                    derived: cloneSerializable(state.derived),
                    selectedModuleKey: state.selectedModuleKey,
                };
            },
            dispose() {
                state.resizeObserver?.disconnect?.();
                if (mount.__kilnDashboardInstance === instance) {
                    delete mount.__kilnDashboardInstance;
                }
                mount.classList.remove('kiln-dashboard-host');
                root.remove();
                return true;
            },
        };

        if (typeof global.ResizeObserver === 'function') {
            state.resizeObserver = new global.ResizeObserver((entries) => {
                const width = entries[0]?.contentRect?.width ?? mount.clientWidth;
                applyResponsiveLayout(width);
            });
            state.resizeObserver.observe(mount);
        } else {
            applyResponsiveLayout(mount.clientWidth);
        }

        mount.__kilnDashboardInstance = instance;
        renderDashboard();
        return instance;
    }

    global.createKilnDashboard = createKilnDashboard;
    global.KilnTwinDashboard = {
        create: createKilnDashboard,
    };
}(window));
