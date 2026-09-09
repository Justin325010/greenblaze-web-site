(function (global) {
    'use strict';

    const SCRIPT_URL = global.document?.currentScript?.src || '';
    const DEFAULTS = {
        mount: 'kiln-twin-ui-overlay',
    };
    const TEMP_RANGE = Object.freeze({
        min: 913,
        max: 1361,
        target: 1225,
        nominalLow: 1215,
        nominalHigh: 1245,
    });
    const OVERLAY_DEFS = [
        {
            key: 'emission',
            label: 'Emission Reduction',
            caption: 'Top Purification',
            x: 50,
            y: 30,
            offsetX: -108,
            offsetY: -106,
            accent: 'green',
            slot: 'top',
            variant: 'progress',
        },
        {
            key: 'efficiency',
            label: 'Efficiency Gain',
            caption: 'Right Thermal Process',
            x: 74,
            y: 56,
            offsetX: 26,
            offsetY: -36,
            accent: 'amber',
            slot: 'right',
            variant: 'progress',
        },
    ];

    function resolveMount(input, fallbackId) {
        if (input && typeof input === 'object' && input.nodeType === 1) return input;
        if (typeof input === 'string' && input) {
            return global.document.getElementById(input) || global.document.querySelector(input);
        }
        if (fallbackId) return global.document.getElementById(fallbackId);
        return null;
    }

    function clamp(value, min, max) {
        return Math.min(Math.max(value, min), max);
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

    function toNumberOrNull(value) {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : null;
    }

    function normalizeProductType(value) {
        const source = String(value || '').trim().toLowerCase();
        if (source === 'small') return 'small';
        if (source === 'large') return 'large';
        return 'unknown';
    }

    function normalizeRadiationState(value, temp) {
        const source = String(value || '').trim().toLowerCase();
        if (['enhance', 'enhanced', 'high', 'strong', 'boost', 'inward', 'focus'].includes(source)) return 'enhance';
        if (['weaken', 'weakened', 'weak', 'low', 'down', 'outward', 'bleed'].includes(source)) return 'weaken';
        if (['steady', 'stable', 'hold', 'normal', 'balanced'].includes(source)) return 'steady';
        if (Number.isFinite(temp)) {
            if (temp >= 1200) return 'enhance';
            if (temp <= 1180) return 'weaken';
            return 'steady';
        }
        return 'unknown';
    }

    function formatTimestamp(value) {
        if (value == null || value === '') return 'Awaiting telemetry';

        let date = null;
        if (typeof value === 'number') {
            date = new Date(value < 1e12 ? value * 1000 : value);
        } else {
            const parsed = new Date(value);
            if (!Number.isNaN(parsed.getTime())) date = parsed;
        }

        if (!date || Number.isNaN(date.getTime())) return 'Online';

        return new Intl.DateTimeFormat('zh-CN', {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: false,
        }).format(date);
    }

    function formatBadge(stamp) {
        if (stamp === 'Awaiting telemetry' || stamp === 'Online') return stamp;
        return `Updated ${stamp}`;
    }

    function formatSigned(value, digits, suffix) {
        if (!Number.isFinite(value)) return '--';
        const fixed = value.toFixed(digits || 0);
        return `${value > 0 ? '+' : ''}${fixed}${suffix || ''}`;
    }

    function formatNumber(value, digits) {
        return Number.isFinite(value) ? value.toFixed(digits || 0) : '--';
    }

    function formatPercent(value, digits) {
        return Number.isFinite(value) ? `${value.toFixed(digits || 0)}%` : '--';
    }

    function formatRatio(value, digits) {
        return Number.isFinite(value) ? `${value.toFixed(digits || 2)}x` : '--';
    }

    function derivePollutionDrop(emissions) {
        if (!Number.isFinite(emissions.CO2) || !Number.isFinite(emissions.NOx)) return null;
        return clamp(100 - ((emissions.CO2 / 6) + (emissions.NOx * 1.4)), 0, 100);
    }

    function normalizeTelemetry(payload) {
        const root = payload && typeof payload === 'object' ? payload : {};
        const body = root.telemetry && typeof root.telemetry === 'object'
            ? { ...root.telemetry, timestamp: root.timestamp ?? root.telemetry.timestamp }
            : root;
        const emissions = body.emissions && typeof body.emissions === 'object' ? body.emissions : {};
        const flame = body.flame && typeof body.flame === 'object' ? body.flame : {};

        const temp = toNumberOrNull(firstDefined(body.temp, body.temperature));
        const efficiency = toNumberOrNull(body.efficiency);
        const productCount = toNumberOrNull(firstDefined(body.productCount, body.product_count));
        const sizeRatio = toNumberOrNull(firstDefined(body.sizeRatio, body.size_ratio, body.productSpec?.sizeFactor));
        const compactMode = Number.isFinite(temp) ? temp >= TEMP_RANGE.target : false;
        const explicitProductType = normalizeProductType(firstDefined(body.product_type, body.productType, body.product));
        const productType = explicitProductType !== 'unknown'
            ? explicitProductType
            : (compactMode ? 'small' : 'large');
        const explicitRadiationState = normalizeRadiationState(firstDefined(body.radiation_state, body.radiationState, body.radiation), temp);
        const radiationState = explicitRadiationState !== 'unknown'
            ? explicitRadiationState
            : (productType === 'small' ? 'weaken' : 'enhance');
        const pollutionDrop = toNumberOrNull(firstDefined(
            body.pollutionDrop,
            body.pollution_drop,
            emissions.pollutionDrop,
            emissions.pollution_drop
        ));
        const normalized = {
            temp,
            efficiency: Number.isFinite(efficiency) ? clamp(efficiency, 0, 100) : null,
            productCount: Number.isFinite(productCount) ? Math.max(0, Math.round(productCount)) : null,
            sizeRatio,
            productType,
            radiationState,
            emissions: {
                CO2: toNumberOrNull(firstDefined(emissions.CO2, emissions.co2)),
                NOx: toNumberOrNull(firstDefined(emissions.NOx, emissions.nox)),
                pollutionDrop,
            },
            flame: {
                blueRatio: toNumberOrNull(firstDefined(flame.blueRatio, flame.blue_ratio)),
                orangeRatio: toNumberOrNull(firstDefined(flame.orangeRatio, flame.orange_ratio)),
                intensity: toNumberOrNull(flame.intensity),
            },
            timestamp: firstDefined(body.timestamp, root.timestamp, null),
        };

        normalized.hasData = [
            normalized.temp,
            normalized.efficiency,
            normalized.productCount,
            normalized.sizeRatio,
            normalized.emissions.CO2,
            normalized.emissions.NOx,
            normalized.emissions.pollutionDrop,
            normalized.flame.blueRatio,
            normalized.flame.orangeRatio,
            normalized.flame.intensity,
        ].some((value) => Number.isFinite(value)) || normalized.radiationState !== 'unknown';

        return normalized;
    }

    function deriveMetrics(telemetry) {
        const tempProgress = Number.isFinite(telemetry.temp)
            ? clamp((telemetry.temp - TEMP_RANGE.min) / (TEMP_RANGE.max - TEMP_RANGE.min), 0, 1)
            : null;
        const tempDelta = Number.isFinite(telemetry.temp)
            ? telemetry.temp - TEMP_RANGE.target
            : null;
        const pollutionDrop = Number.isFinite(telemetry.emissions.pollutionDrop)
            ? clamp(telemetry.emissions.pollutionDrop, 0, 100)
            : derivePollutionDrop(telemetry.emissions);
        const radiationBias = telemetry.radiationState === 'enhance'
            ? 8
            : telemetry.radiationState === 'weaken'
                ? -10
                : 0;
        const warmPercent = Number.isFinite(telemetry.flame.orangeRatio)
            ? clamp(telemetry.flame.orangeRatio * 100, 0, 100)
            : (Number.isFinite(telemetry.temp)
                ? clamp(((telemetry.temp - 1080) / 2.4) + radiationBias, 0, 100)
                : null);
        const coolPercent = Number.isFinite(warmPercent) ? 100 - warmPercent : null;
        const flameIntensity = Number.isFinite(telemetry.flame.intensity)
            ? clamp(telemetry.flame.intensity * 100, 0, 100)
            : (Number.isFinite(tempProgress) ? tempProgress * 100 : null);

        const compactMode = Number.isFinite(telemetry.temp) ? telemetry.temp >= TEMP_RANGE.target : false;
        const tempTone = !Number.isFinite(telemetry.temp)
            ? 'idle'
            : compactMode
                ? 'warning'
                : 'low';
        const tempBandLabel = !Number.isFinite(telemetry.temp)
            ? 'Awaiting temperature data'
            : compactMode
                ? 'High-Temperature Confinement'
                : 'Heating Dispersion';

        const emissionTone = !Number.isFinite(pollutionDrop)
            ? 'idle'
            : pollutionDrop >= 32
                ? 'nominal'
                : pollutionDrop >= 20
                    ? 'low'
                    : 'warning';
        const emissionState = !Number.isFinite(pollutionDrop)
            ? 'Awaiting emissions data'
            : pollutionDrop >= 32
                ? 'Purification Chain Stable'
                : pollutionDrop >= 20
                    ? 'Emissions Still Being Optimized'
                    : 'Check DeNOx and Combustion';

        const efficiencyTone = !Number.isFinite(telemetry.efficiency)
            ? 'idle'
            : telemetry.efficiency >= 90
                ? 'nominal'
                : telemetry.efficiency >= 86
                    ? 'low'
                    : 'warning';
        const efficiencyState = !Number.isFinite(telemetry.efficiency)
            ? 'Awaiting efficiency data'
            : telemetry.efficiency >= 90
                ? 'Excellent Thermal Efficiency'
                : telemetry.efficiency >= 86
                    ? 'Thermal Efficiency Stable'
                    : 'Optimization Room Remains';

        const radiationLabel = telemetry.radiationState === 'enhance' ? 'Inward Circulation' : 'Outward Circulation';
        const radiationDirection = telemetry.radiationState === 'enhance' ? 'Parallel Inward' : 'Diffusing Outward';
        const radiationTone = telemetry.radiationState === 'enhance' ? 'warning' : 'low';
        const radiationStateText = Number.isFinite(flameIntensity)
            ? `Flame Intensity ${formatPercent(flameIntensity, 0)}`
            : 'Awaiting flame linkage data';

        return {
            compactMode,
            tempProgress,
            tempDelta,
            tempTone,
            tempBandLabel,
            pollutionDrop,
            emissionTone,
            emissionState,
            efficiencyTone,
            efficiencyState,
            warmPercent,
            coolPercent,
            flameIntensity,
            radiationTone,
            radiationLabel,
            radiationDirection,
            radiationStateText,
        };
    }

    function ensureStylesheet() {
        const href = (() => {
            try {
                return SCRIPT_URL ? new URL('../css/kiln-overlays.css', SCRIPT_URL).href : 'assets/css/kiln-overlays.css';
            } catch (error) {
                return 'assets/css/kiln-overlays.css';
            }
        })();

        const existing = global.document.querySelector(`link[data-kiln-overlay-styles="true"], link[href="${href}"]`);
        if (existing) return existing;

        const link = global.document.createElement('link');
        link.rel = 'stylesheet';
        link.href = href;
        link.dataset.kilnOverlayStyles = 'true';
        global.document.head.appendChild(link);
        return link;
    }

    function createElement(tagName, className, text) {
        const element = global.document.createElement(tagName);
        if (className) element.className = className;
        if (text != null) element.textContent = text;
        return element;
    }

    function updateProgressBar(fill, percent) {
        if (!fill) return;
        fill.style.width = Number.isFinite(percent) ? `${clamp(percent, 0, 100)}%` : '0%';
    }

    function updateThermometer(overlay, progress, temp) {
        if (!overlay.thermometerFill || !overlay.thermometerCursor) return;
        const targetPercent = ((TEMP_RANGE.target - TEMP_RANGE.min) / (TEMP_RANGE.max - TEMP_RANGE.min)) * 100;
        overlay.thermometerTarget.style.left = `${targetPercent}%`;
        if (overlay.thermometerTargetLabel) {
            overlay.thermometerTargetLabel.style.left = `${targetPercent}%`;
        }

        if (!Number.isFinite(progress)) {
            overlay.thermometerFill.style.width = '0%';
            overlay.thermometerCursor.style.left = '0%';
            overlay.thermometerCursor.dataset.active = 'false';
            if (overlay.thermometerCursorLabel) overlay.thermometerCursorLabel.textContent = '--';
            return;
        }

        const percent = clamp(progress * 100, 0, 100);
        overlay.thermometerFill.style.width = `${percent}%`;
        overlay.thermometerCursor.style.left = `${percent}%`;
        overlay.thermometerCursor.dataset.active = 'true';
        if (overlay.thermometerCursorLabel && Number.isFinite(temp)) {
            overlay.thermometerCursorLabel.textContent = `${Math.round(temp)}`;
        }
    }

    function updateRadiationBalance(overlay, coolPercent, warmPercent) {
        if (!overlay.coolBar || !overlay.warmBar) return;
        overlay.coolBar.style.width = Number.isFinite(coolPercent) ? `${clamp(coolPercent, 0, 100)}%` : '50%';
        overlay.warmBar.style.width = Number.isFinite(warmPercent) ? `${clamp(warmPercent, 0, 100)}%` : '50%';
    }

    function buildOverlayNode(definition) {
        const node = createElement('article', `kiln-overlay-node kiln-overlay-node--${definition.accent} kiln-overlay-node--${definition.slot}`);
        node.style.left = `${definition.x}%`;
        node.style.top = `${definition.y}%`;
        node.dataset.metric = definition.key;
        node.style.setProperty('--offset-x', `${definition.offsetX}px`);
        node.style.setProperty('--offset-y', `${definition.offsetY}px`);

        const anchor = createElement('span', 'kiln-overlay-node__anchor');
        const pulse = createElement('span', 'kiln-overlay-node__pulse');
        const line = createElement('span', 'kiln-overlay-node__line');
        const card = createElement('section', 'kiln-overlay-card');
        card.dataset.tone = 'idle';
        card.dataset.metric = definition.key;

        const header = createElement('div', 'kiln-overlay-card__header');
        const kicker = createElement('div', 'kiln-overlay-card__kicker', definition.caption);
        const badge = createElement('span', 'kiln-overlay-card__badge', 'Awaiting telemetry');
        header.append(kicker, badge);

        const label = createElement('div', 'kiln-overlay-card__label', definition.label);
        const valueRow = createElement('div', 'kiln-overlay-card__value-row');
        const value = createElement('div', 'kiln-overlay-card__value', '--');
        const trend = createElement('span', 'kiln-overlay-card__trend');
        valueRow.append(value, trend);
        const meta = createElement('div', 'kiln-overlay-card__meta', 'Awaiting telemetry-driven update');
        const visual = createElement('div', 'kiln-overlay-card__visual');
        const detail = createElement('div', 'kiln-overlay-card__detail', 'Neutral display is used when live data is unavailable');
        const state = createElement('div', 'kiln-overlay-card__state');
        const stateDot = createElement('span', 'kiln-overlay-card__state-dot');
        const stateText = createElement('span', 'kiln-overlay-card__state-text', 'Status pending');
        state.append(stateDot, stateText);

        const refs = {
            node,
            card,
            badge,
            value,
            trend,
            meta,
            detail,
            stateText,
        };

        if (definition.variant === 'temp') {
            const thermometer = createElement('div', 'kiln-overlay-thermometer');
            const thermometerTrack = createElement('div', 'kiln-overlay-thermometer__track');
            const thermometerFill = createElement('span', 'kiln-overlay-thermometer__fill');
            const thermometerTarget = createElement('span', 'kiln-overlay-thermometer__target');
            const thermometerTargetLabel = createElement('span', 'kiln-overlay-thermometer__target-label', `${TEMP_RANGE.target}`);
            const thermometerCursor = createElement('span', 'kiln-overlay-thermometer__cursor');
            const thermometerCursorLabel = createElement('span', 'kiln-overlay-thermometer__cursor-label', '--');
            thermometerCursor.appendChild(thermometerCursorLabel);
            thermometerTrack.append(thermometerFill, thermometerTarget, thermometerTargetLabel, thermometerCursor);

            const thermometerScale = createElement('div', 'kiln-overlay-thermometer__scale');
            thermometerScale.append(
                createElement('span', '', `${TEMP_RANGE.min}℃`),
                createElement('span', 'kiln-overlay-thermometer__scale-target', `Target ${TEMP_RANGE.target}℃`),
                createElement('span', '', `${TEMP_RANGE.max}℃`)
            );

            thermometer.append(thermometerTrack, thermometerScale);
            visual.appendChild(thermometer);

            refs.thermometerFill = thermometerFill;
            refs.thermometerTarget = thermometerTarget;
            refs.thermometerTargetLabel = thermometerTargetLabel;
            refs.thermometerCursor = thermometerCursor;
            refs.thermometerCursorLabel = thermometerCursorLabel;
        } else if (definition.variant === 'radiation') {
            const balance = createElement('div', 'kiln-overlay-radiation');
            const directionTag = createElement('div', 'kiln-overlay-radiation__direction');
            const split = createElement('div', 'kiln-overlay-radiation__split');
            const coolBar = createElement('span', 'kiln-overlay-radiation__part kiln-overlay-radiation__part--cool');
            const warmBar = createElement('span', 'kiln-overlay-radiation__part kiln-overlay-radiation__part--warm');
            const legend = createElement('div', 'kiln-overlay-radiation__legend', 'Blue Flame / Warm Flame');
            split.append(coolBar, warmBar);
            balance.append(directionTag, split, legend);
            visual.appendChild(balance);

            refs.coolBar = coolBar;
            refs.warmBar = warmBar;
            refs.radiationLegend = legend;
            refs.radiationDirection = directionTag;
        } else if (definition.key === 'emission') {
            const emissionVisual = createElement('div', 'kiln-overlay-emission-detail');
            const co2Row = createElement('div', 'kiln-overlay-emission-detail__row');
            const co2Label = createElement('span', 'kiln-overlay-emission-detail__label', 'CO₂');
            const co2Value = createElement('span', 'kiln-overlay-emission-detail__val', '-- ppm');
            co2Row.append(co2Label, co2Value);
            const noxRow = createElement('div', 'kiln-overlay-emission-detail__row');
            const noxLabel = createElement('span', 'kiln-overlay-emission-detail__label', 'NOx');
            const noxValue = createElement('span', 'kiln-overlay-emission-detail__val', '-- ppm');
            noxRow.append(noxLabel, noxValue);
            emissionVisual.append(co2Row, noxRow);
            visual.appendChild(emissionVisual);

            const progress = createElement('div', 'kiln-overlay-progress');
            const progressFill = createElement('span', 'kiln-overlay-progress__fill');
            progress.appendChild(progressFill);
            visual.appendChild(progress);

            refs.progressFill = progressFill;
            refs.co2Value = co2Value;
            refs.noxValue = noxValue;
        } else {
            const progress = createElement('div', 'kiln-overlay-progress');
            const progressFill = createElement('span', 'kiln-overlay-progress__fill');
            progress.appendChild(progressFill);
            visual.appendChild(progress);

            const tierTag = createElement('div', 'kiln-overlay-efficiency-tier');
            visual.appendChild(tierTag);

            refs.progressFill = progressFill;
            refs.efficiencyTier = tierTag;
        }

        card.append(header, label, valueRow, meta, visual, detail, state);

        const lineLength = Math.sqrt((definition.offsetX ** 2) + (definition.offsetY ** 2));
        const lineAngle = Math.atan2(definition.offsetY, definition.offsetX) * (180 / Math.PI);
        line.style.setProperty('--line-length', `${lineLength}px`);
        line.style.setProperty('--line-angle', `${lineAngle}deg`);

        node.append(anchor, pulse, line, card);
        return refs;
    }

    function createKilnOverlays(options) {
        ensureStylesheet();

        const settings = {
            ...DEFAULTS,
            ...(options || {}),
        };
        const mount = resolveMount(settings.mount, DEFAULTS.mount);

        if (!mount) {
            console.warn('[KilnOverlays] Mount container not found.');
            return {
                updateTelemetry() {
                    return null;
                },
                dispose() {
                    return true;
                },
            };
        }

        mount.__kilnOverlaysInstance?.dispose?.();

        const root = createElement('div', 'kiln-overlay-root');
        root.setAttribute('aria-hidden', 'true');

        const items = new Map();
        OVERLAY_DEFS.forEach((definition) => {
            const overlay = buildOverlayNode(definition);
            items.set(definition.key, overlay);
            root.appendChild(overlay.node);
        });

        mount.replaceChildren(root);
        mount.classList.add('kiln-overlay-mount');
        mount.__kilnOverlaysInstance = null;

        function updateTempOverlay(overlay, telemetry, metrics, stamp) {
            const hasTemp = Number.isFinite(telemetry.temp);
            overlay.value.textContent = hasTemp ? `${formatNumber(telemetry.temp, 0)}℃` : '--℃';
            if (overlay.trend) {
                if (!hasTemp) {
                    overlay.trend.textContent = '';
                    overlay.trend.className = 'kiln-overlay-card__trend';
                } else if (metrics.compactMode) {
                    overlay.trend.textContent = '▼ Control';
                    overlay.trend.className = 'kiln-overlay-card__trend kiln-overlay-card__trend--down';
                } else {
                    overlay.trend.textContent = '▲ Heat Up';
                    overlay.trend.className = 'kiln-overlay-card__trend kiln-overlay-card__trend--up';
                }
            }
            overlay.meta.textContent = hasTemp
                ? `${metrics.compactMode ? 'Heat transfer confined beyond threshold' : 'Pre-threshold heating dispersion'} · ${metrics.tempBandLabel}`
                : 'Awaiting temperature data';
            overlay.detail.textContent = hasTemp
                ? `${metrics.compactMode ? 'Blue downward arrows indicate controlled cooling' : 'Red upward arrows indicate temperature lift'}`
                : `Detectable range ${TEMP_RANGE.min}~${TEMP_RANGE.max}℃`;
            overlay.badge.textContent = formatBadge(stamp);
            overlay.stateText.textContent = metrics.tempBandLabel;
            overlay.card.dataset.tone = metrics.tempTone;
            updateThermometer(overlay, metrics.tempProgress, telemetry.temp);
        }

        function updateEmissionOverlay(overlay, telemetry, metrics, stamp) {
            const hasDrop = Number.isFinite(metrics.pollutionDrop);
            overlay.value.textContent = hasDrop ? `↓${formatPercent(metrics.pollutionDrop, 0)}` : '--';
            // Trend for emission
            if (overlay.trend) {
                if (!hasDrop) {
                    overlay.trend.textContent = '';
                    overlay.trend.className = 'kiln-overlay-card__trend';
                } else if (metrics.pollutionDrop >= 32) {
                    overlay.trend.textContent = '✓ On Target';
                    overlay.trend.className = 'kiln-overlay-card__trend kiln-overlay-card__trend--good';
                } else if (metrics.pollutionDrop >= 20) {
                    overlay.trend.textContent = '~ Optimizing';
                    overlay.trend.className = 'kiln-overlay-card__trend kiln-overlay-card__trend--steady';
                } else {
                    overlay.trend.textContent = '! Watch';
                    overlay.trend.className = 'kiln-overlay-card__trend kiln-overlay-card__trend--warn';
                }
            }
            // Sub-values for CO2 / NOx
            if (overlay.co2Value) {
                overlay.co2Value.textContent = Number.isFinite(telemetry.emissions.CO2)
                    ? `${formatNumber(telemetry.emissions.CO2, 0)} ppm` : '-- ppm';
                overlay.co2Value.dataset.level = Number.isFinite(telemetry.emissions.CO2)
                    ? (telemetry.emissions.CO2 <= 200 ? 'good' : telemetry.emissions.CO2 <= 400 ? 'mid' : 'high') : 'idle';
            }
            if (overlay.noxValue) {
                overlay.noxValue.textContent = Number.isFinite(telemetry.emissions.NOx)
                    ? `${formatNumber(telemetry.emissions.NOx, 0)} ppm` : '-- ppm';
                overlay.noxValue.dataset.level = Number.isFinite(telemetry.emissions.NOx)
                    ? (telemetry.emissions.NOx <= 20 ? 'good' : telemetry.emissions.NOx <= 40 ? 'mid' : 'high') : 'idle';
            }
            overlay.meta.textContent = metrics.emissionState;
            overlay.detail.textContent = hasDrop
                ? 'Emission reduction is derived in real time from CO₂ + NOx'
                : 'Neutral display is used when emissions fields are missing';
            overlay.badge.textContent = formatBadge(stamp);
            overlay.stateText.textContent = metrics.emissionState;
            overlay.card.dataset.tone = metrics.emissionTone;
            updateProgressBar(overlay.progressFill, metrics.pollutionDrop);
        }

        function updateEfficiencyOverlay(overlay, telemetry, metrics, stamp) {
            const hasEff = Number.isFinite(telemetry.efficiency);
            overlay.value.textContent = hasEff ? formatPercent(telemetry.efficiency, 1) : '--';
            if (overlay.trend) {
                if (!hasEff) {
                    overlay.trend.textContent = '';
                    overlay.trend.className = 'kiln-overlay-card__trend';
                } else {
                    overlay.trend.textContent = '▲ Rising';
                    overlay.trend.className = 'kiln-overlay-card__trend kiln-overlay-card__trend--up';
                }
            }
            if (overlay.efficiencyTier) {
                if (!hasEff) {
                    overlay.efficiencyTier.textContent = '';
                    overlay.efficiencyTier.dataset.tier = 'idle';
                } else if (telemetry.efficiency >= 90) {
                    overlay.efficiencyTier.textContent = 'Excellent ≥90%';
                    overlay.efficiencyTier.dataset.tier = 'excellent';
                } else if (telemetry.efficiency >= 86) {
                    overlay.efficiencyTier.textContent = 'Stable ≥86%';
                    overlay.efficiencyTier.dataset.tier = 'stable';
                } else {
                    overlay.efficiencyTier.textContent = 'Optimize <86%';
                    overlay.efficiencyTier.dataset.tier = 'alert';
                }
            }
            overlay.meta.textContent = [
                metrics.compactMode ? 'Efficiency keeps rising in the high-temperature zone' : 'Efficiency climbs together during the heating stage',
                Number.isFinite(telemetry.productCount) ? `Load ${formatNumber(telemetry.productCount, 0)} units` : 'Load pending',
            ].join(' · ');
            overlay.detail.textContent = telemetry.productType !== 'unknown'
                ? `${metrics.compactMode ? 'Small parts are fired in multiple rows, with the red efficiency arrow trending upward' : 'Large parts are fired in small batches, with the red efficiency arrow trending upward'}`
                : 'Only efficiency is shown when the product type is unavailable';
            overlay.badge.textContent = formatBadge(stamp);
            overlay.stateText.textContent = metrics.efficiencyState;
            overlay.card.dataset.tone = metrics.efficiencyTone;
            updateProgressBar(overlay.progressFill, telemetry.efficiency);
        }

        function updateRadiationOverlay(overlay, telemetry, metrics, stamp) {
            overlay.value.textContent = metrics.radiationLabel;
            if (overlay.radiationDirection) {
                overlay.radiationDirection.textContent = metrics.radiationDirection;
                overlay.radiationDirection.dataset.dir = telemetry.radiationState;
            }
            if (overlay.trend) {
                if (telemetry.radiationState === 'enhance') {
                    overlay.trend.textContent = '⇄ Inward';
                    overlay.trend.className = 'kiln-overlay-card__trend kiln-overlay-card__trend--up';
                } else if (telemetry.radiationState === 'weaken') {
                    overlay.trend.textContent = '↗ Outward';
                    overlay.trend.className = 'kiln-overlay-card__trend kiln-overlay-card__trend--down';
                } else {
                    overlay.trend.textContent = '';
                    overlay.trend.className = 'kiln-overlay-card__trend';
                }
            }
            overlay.meta.textContent = `${metrics.radiationDirection}${Number.isFinite(metrics.flameIntensity) ? ` · Flame ${formatPercent(metrics.flameIntensity, 0)}` : ''}`;
            overlay.detail.textContent = Number.isFinite(metrics.coolPercent) && Number.isFinite(metrics.warmPercent)
                ? `Blue Flame ${formatPercent(metrics.coolPercent, 0)} · Warm Flame ${formatPercent(metrics.warmPercent, 0)}`
                : 'Awaiting flame-ratio linkage';
            overlay.badge.textContent = formatBadge(stamp);
            overlay.stateText.textContent = metrics.radiationStateText;
            overlay.card.dataset.tone = metrics.radiationTone;
            overlay.card.dataset.state = telemetry.radiationState;
            if (overlay.radiationLegend) {
                overlay.radiationLegend.textContent = Number.isFinite(metrics.coolPercent) && Number.isFinite(metrics.warmPercent)
                    ? `Blue Flame ${formatPercent(metrics.coolPercent, 0)} / Warm Flame ${formatPercent(metrics.warmPercent, 0)}`
                    : 'Blue Flame / Warm Flame';
            }
            updateRadiationBalance(overlay, metrics.coolPercent, metrics.warmPercent);
        }

        const instance = {
            updateTelemetry(payload) {
                const telemetry = normalizeTelemetry(payload);
                const metrics = deriveMetrics(telemetry);
                const stamp = formatTimestamp(telemetry.timestamp);

                if (items.has('emission')) {
                    updateEmissionOverlay(items.get('emission'), telemetry, metrics, stamp);
                }
                if (items.has('efficiency')) {
                    updateEfficiencyOverlay(items.get('efficiency'), telemetry, metrics, stamp);
                }

                root.dataset.radiationState = telemetry.radiationState;
                root.dataset.productType = telemetry.productType;
                root.dataset.telemetryReady = telemetry.hasData ? 'true' : 'false';

                return {
                    telemetry,
                    derived: metrics,
                };
            },
            dispose() {
                if (mount.__kilnOverlaysInstance === instance) {
                    delete mount.__kilnOverlaysInstance;
                }
                mount.classList.remove('kiln-overlay-mount');
                root.remove();
                return true;
            },
        };

        mount.__kilnOverlaysInstance = instance;
        instance.updateTelemetry();
        return instance;
    }

    global.createKilnOverlays = createKilnOverlays;
    global.KilnTwinOverlays = {
        create: createKilnOverlays,
    };
}(window));
