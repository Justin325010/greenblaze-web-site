(function (global) {
    'use strict';

    const VERSION = '0.3.0';
    const SCHEMA_VERSION = 'kiln.telemetry.v1';
    const TEMPERATURE_LIMITS = Object.freeze({
        inputMin: 800,
        inputMax: 1450,
        profileMin: 913,
        profileMax: 1361,
    });

    function clone(value) {
        if (value == null) return value;
        return JSON.parse(JSON.stringify(value));
    }

    function clamp(value, min, max) {
        return Math.min(max, Math.max(min, value));
    }

    function round(value, digits) {
        const factor = Math.pow(10, digits);
        return Math.round(value * factor) / factor;
    }

    function toFiniteNumber(value, fallback) {
        const numeric = Number(value);
        return Number.isFinite(numeric) ? numeric : fallback;
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

    function toUnitInterval(value, fallback) {
        const numeric = toFiniteNumber(value, fallback);
        if (!Number.isFinite(numeric)) return fallback;
        if (numeric > 1) return clamp(numeric / 100, 0, 1);
        return clamp(numeric, 0, 1);
    }

    function normalizeTemperature(value, fallback = 1180) {
        return round(clamp(toFiniteNumber(value, fallback), TEMPERATURE_LIMITS.inputMin, TEMPERATURE_LIMITS.inputMax), 1);
    }

    function deriveHeatUnit(temp) {
        return clamp(
            (temp - TEMPERATURE_LIMITS.profileMin) / (TEMPERATURE_LIMITS.profileMax - TEMPERATURE_LIMITS.profileMin),
            0,
            1
        );
    }

    function normalizeProductType(value, temp) {
        const normalized = String(value || '').trim().toLowerCase();
        if (normalized === 'large' || normalized === 'small') return normalized;
        return temp >= 1210 ? 'small' : 'large';
    }

    function normalizeRadiationState(value, temp) {
        const normalized = String(value || '').trim().toLowerCase();
        if (['enhance', 'enhanced', 'boost', 'high', 'up', 'inward', 'focus', 'strong'].includes(normalized)) return 'enhance';
        if (['weaken', 'weakened', 'weak', 'low', 'down', 'outward', 'bleed'].includes(normalized)) return 'weaken';
        if (['steady', 'stable', 'hold', 'normal', 'balanced', 'auto'].includes(normalized)) return 'steady';
        if (temp >= 1205) return 'enhance';
        if (temp <= 1165) return 'weaken';
        return 'steady';
    }

    function normalizeRadiationMode(value, radiationState) {
        const normalized = String(value || '').trim().toLowerCase();
        if (['inward', 'enhance', 'enhanced', 'focus', 'strong'].includes(normalized)) return 'inward';
        if (['outward', 'weaken', 'weakened', 'bleed', 'weak'].includes(normalized)) return 'outward';
        if (['auto', 'steady', 'stable', 'hold', 'normal'].includes(normalized)) return 'auto';
        if (radiationState === 'enhance') return 'inward';
        if (radiationState === 'weaken') return 'outward';
        return 'auto';
    }

    function deriveProductSizeRatio(temp, productType) {
        const normalized = deriveHeatUnit(temp);
        const minScale = productType === 'large' ? 0.7 : 0.82;
        const maxScale = productType === 'large' ? 1.2 : 1.12;
        return round(maxScale + ((minScale - maxScale) * normalized), 3);
    }

    function deriveEfficiencyPercent(temp, radiationState, productType) {
        const heat = deriveHeatUnit(temp);
        const stateBias = radiationState === 'enhance'
            ? 0.8
            : radiationState === 'weaken'
                ? -1.2
                : 1.4;
        const productBias = productType === 'small' ? 1.2 : -0.4;
        return round(clamp(82 + (heat * 10) + stateBias + productBias, 78, 96), 1);
    }

    function deriveRadiationIntensity(temp, radiationState, efficiency) {
        const heat = deriveHeatUnit(temp);
        const efficiencyLift = clamp((efficiency - 85) / 40, -0.1, 0.1);
        const stateBias = radiationState === 'enhance'
            ? 0.18
            : radiationState === 'weaken'
                ? -0.14
                : 0.03;
        return round(clamp(0.32 + (heat * 0.44) + stateBias + efficiencyLift, 0.08, 1), 3);
    }

    function deriveFlameProfile(temp, radiationState, radiationIntensity) {
        const heat = deriveHeatUnit(temp);
        const stateBias = radiationState === 'enhance'
            ? 0.12
            : radiationState === 'weaken'
                ? -0.12
                : 0;
        const orangeRatio = clamp(0.2 + (heat * 0.58) + stateBias + ((radiationIntensity - 0.5) * 0.12), 0.08, 0.92);
        const blueRatio = 1 - orangeRatio;
        const intensity = clamp(0.26 + (heat * 0.42) + ((radiationIntensity - 0.5) * 0.44), 0.06, 1);
        return {
            blueRatio: round(blueRatio, 3),
            blue_ratio: round(blueRatio, 3),
            orangeRatio: round(orangeRatio, 3),
            orange_ratio: round(orangeRatio, 3),
            intensity: round(intensity, 3),
        };
    }

    function normalizeFlameProfile(flameRoot, derivedFlame) {
        let blueRatio = toUnitInterval(firstDefined(flameRoot.blueRatio, flameRoot.blue_ratio), undefined);
        let orangeRatio = toUnitInterval(firstDefined(flameRoot.orangeRatio, flameRoot.orange_ratio), undefined);

        if (Number.isFinite(blueRatio) && !Number.isFinite(orangeRatio)) {
            orangeRatio = 1 - blueRatio;
        } else if (!Number.isFinite(blueRatio) && Number.isFinite(orangeRatio)) {
            blueRatio = 1 - orangeRatio;
        } else if (Number.isFinite(blueRatio) && Number.isFinite(orangeRatio)) {
            const total = blueRatio + orangeRatio;
            if (total > 0) {
                blueRatio /= total;
                orangeRatio /= total;
            } else {
                blueRatio = derivedFlame.blueRatio;
                orangeRatio = derivedFlame.orangeRatio;
            }
        } else {
            blueRatio = derivedFlame.blueRatio;
            orangeRatio = derivedFlame.orangeRatio;
        }

        const intensity = toUnitInterval(flameRoot.intensity, derivedFlame.intensity);
        blueRatio = round(clamp(blueRatio, 0, 1), 3);
        orangeRatio = round(clamp(orangeRatio, 0, 1), 3);

        return {
            blueRatio,
            blue_ratio: blueRatio,
            orangeRatio,
            orange_ratio: orangeRatio,
            intensity: round(clamp(intensity, 0, 1), 3),
        };
    }

    function deriveEmissionBaseline(temp, efficiency, productType, radiationState) {
        const heat = deriveHeatUnit(temp);
        const efficiencyDrag = clamp((100 - efficiency) / 100, 0, 1);
        return {
            CO2: round(
                clamp(
                    488 - (heat * 46) - ((efficiency - 80) * 2.8)
                        + (productType === 'large' ? 10 : -6)
                        + (radiationState === 'enhance' ? 10 : radiationState === 'weaken' ? -8 : 0),
                    330,
                    520
                ),
                1
            ),
            NOx: round(
                clamp(
                    22 + (heat * 9) + (efficiencyDrag * 10)
                        + (productType === 'small' ? 1.4 : -0.8)
                        + (radiationState === 'enhance' ? 4 : radiationState === 'weaken' ? -2.5 : 0),
                    12,
                    48
                ),
                1
            ),
        };
    }

    function derivePollutionDrop(emissions) {
        const co2Lift = clamp((520 - emissions.CO2) / 2.4, 0, 65);
        const noxLift = clamp((50 - emissions.NOx) * 1.75, 0, 35);
        return round(clamp((co2Lift * 0.65) + (noxLift * 0.35), 0, 100), 1);
    }

    function normalizeEmissions(rawEmissions, temp, efficiency, productType, radiationState, explicitDrop) {
        const emissions = rawEmissions && typeof rawEmissions === 'object' ? rawEmissions : {};
        const baseline = deriveEmissionBaseline(temp, efficiency, productType, radiationState);
        let co2 = toFiniteNumber(firstDefined(emissions.CO2, emissions.co2), undefined);
        let nox = toFiniteNumber(firstDefined(emissions.NOx, emissions.nox), undefined);
        const targetDrop = toFiniteNumber(explicitDrop, undefined);

        if (Number.isFinite(targetDrop)) {
            if (!Number.isFinite(nox)) nox = baseline.NOx;
            if (!Number.isFinite(co2)) {
                const noxScore = clamp((50 - nox) * 1.75, 0, 35);
                const co2Score = clamp((targetDrop - (noxScore * 0.35)) / 0.65, 0, 65);
                co2 = 520 - (co2Score * 2.4);
            }
        }

        co2 = round(clamp(toFiniteNumber(co2, baseline.CO2), 0, 5000), 1);
        nox = round(clamp(toFiniteNumber(nox, baseline.NOx), 0, 5000), 1);
        const pollutionDrop = derivePollutionDrop({ CO2: co2, NOx: nox });

        return {
            CO2: co2,
            co2,
            NOx: nox,
            nox,
            pollutionDrop,
            pollution_drop: pollutionDrop,
        };
    }

    function normalizeProductCount(rawValue, productType) {
        const fallback = productType === 'small' ? 36 : 12;
        const max = productType === 'small' ? 48 : 24;
        const min = productType === 'small' ? 4 : 2;
        return Math.round(clamp(toFiniteNumber(rawValue, fallback), min, max));
    }

    function buildFrame(moduleKey, moduleLabel, frame) {
        const root = frame && typeof frame === 'object' ? frame : {};
        const telemetryRoot = root.telemetry && typeof root.telemetry === 'object' ? root.telemetry : root;
        const thermalRoot = telemetryRoot.thermal && typeof telemetryRoot.thermal === 'object' ? telemetryRoot.thermal : {};
        const productRoot = telemetryRoot.product && typeof telemetryRoot.product === 'object' ? telemetryRoot.product : {};
        const productSpecRoot = telemetryRoot.productSpec && typeof telemetryRoot.productSpec === 'object' ? telemetryRoot.productSpec : {};
        const environmentRoot = telemetryRoot.environment && typeof telemetryRoot.environment === 'object' ? telemetryRoot.environment : {};
        const flameRoot = telemetryRoot.flame && typeof telemetryRoot.flame === 'object' ? telemetryRoot.flame : {};
        const temp = normalizeTemperature(firstDefined(
            telemetryRoot.temp,
            telemetryRoot.temperature,
            root.temp,
            root.temperature,
            thermalRoot.temp,
            thermalRoot.temperature
        ));
        const productType = normalizeProductType(firstDefined(
            telemetryRoot.productType,
            telemetryRoot.product_type,
            telemetryRoot.product,
            root.productType,
            root.product_type,
            root.product,
            productRoot.type,
            productSpecRoot.type
        ), temp);
        const radiationState = normalizeRadiationState(firstDefined(
            telemetryRoot.radiationState,
            telemetryRoot.radiation_state,
            telemetryRoot.radiation,
            root.radiationState,
            root.radiation_state,
            root.radiation,
            thermalRoot.radiationState,
            thermalRoot.radiation_state
        ), temp);
        const efficiency = round(clamp(
            toFiniteNumber(
                firstDefined(
                    telemetryRoot.efficiency,
                    root.efficiency,
                    thermalRoot.efficiency
                ),
                undefined
            ) ?? (toUnitInterval(
                firstDefined(
                    telemetryRoot.efficiencyRatio,
                    telemetryRoot.efficiency_ratio,
                    root.efficiencyRatio,
                    root.efficiency_ratio
                ),
                undefined
            ) * 100),
            0,
            100
        ) || deriveEfficiencyPercent(temp, radiationState, productType), 1);
        const efficiencyRatio = round(clamp(efficiency / 100, 0, 1), 3);
        const sizeRatio = round(clamp(
            toFiniteNumber(
                firstDefined(
                    telemetryRoot.sizeRatio,
                    telemetryRoot.size_ratio,
                    root.sizeRatio,
                    root.size_ratio,
                    productRoot.sizeRatio,
                    productSpecRoot.sizeFactor,
                    productSpecRoot.sizeRatio
                ),
                deriveProductSizeRatio(temp, productType)
            ),
            0.4,
            1.6
        ), 3);
        const productCount = normalizeProductCount(firstDefined(
            telemetryRoot.productCount,
            telemetryRoot.product_count,
            root.productCount,
            root.product_count,
            productRoot.count,
            productSpecRoot.productCount,
            productSpecRoot.count
        ), productType);
        const emissions = normalizeEmissions(
            telemetryRoot.emissions || root.emissions,
            temp,
            efficiency,
            productType,
            radiationState,
            firstDefined(
                telemetryRoot.pollutionDrop,
                telemetryRoot.pollution_drop,
                root.pollutionDrop,
                root.pollution_drop
            )
        );
        const radiationMode = normalizeRadiationMode(firstDefined(
            telemetryRoot.radiationMode,
            telemetryRoot.radiation_mode,
            root.radiationMode,
            root.radiation_mode
        ), radiationState);
        const radiationIntensity = round(clamp(
            toUnitInterval(
                firstDefined(
                    telemetryRoot.radiationIntensity,
                    telemetryRoot.radiation_intensity,
                    root.radiationIntensity,
                    root.radiation_intensity
                ),
                deriveRadiationIntensity(temp, radiationState, efficiency)
            ),
            0,
            1
        ), 3);
        const ambientTemp = round(clamp(toFiniteNumber(firstDefined(
            telemetryRoot.ambientTemp,
            telemetryRoot.ambient_temp,
            root.ambientTemp,
            root.ambient_temp,
            environmentRoot.ambientTemp,
            environmentRoot.ambient_temp
        ), 25), -20, 80), 1);
        const humidity = round(clamp(toFiniteNumber(firstDefined(
            telemetryRoot.humidity,
            root.humidity,
            environmentRoot.humidity
        ), 45), 0, 100), 1);
        const flame = normalizeFlameProfile(
            flameRoot,
            deriveFlameProfile(temp, radiationState, radiationIntensity)
        );
        const timestamp = Math.floor(toFiniteNumber(root.timestamp, Date.now() / 1000));
        const thermal = {
            temp,
            temperature: temp,
            band: temp >= 1275 ? 'high-fire' : temp >= 1215 ? 'holding' : temp >= 1140 ? 'ramp' : 'preheat',
            radiationState,
            radiation_state: radiationState,
            radiationMode,
            radiation_mode: radiationMode,
            radiationIntensity,
            radiation_intensity: radiationIntensity,
            efficiency,
            efficiencyRatio,
            efficiency_ratio: efficiencyRatio,
        };
        const productSpec = {
            type: productType,
            productType,
            product_type: productType,
            count: productCount,
            productCount,
            product_count: productCount,
            sizeFactor: sizeRatio,
            sizeRatio,
            size_ratio: sizeRatio,
            size_factor: sizeRatio,
            sizeClass: sizeRatio >= 1.08 ? 'expanded' : sizeRatio <= 0.92 ? 'compact' : 'nominal',
        };
        const environment = {
            ambientTemp,
            ambient_temp: ambientTemp,
            humidity,
        };
        const derived = {
            heat: round(deriveHeatUnit(temp), 3),
            temperatureBand: thermal.band,
            radiationMode,
            radiationIntensity,
            efficiencyRatio,
            pollutionDrop: emissions.pollutionDrop,
            emissionState: emissions.pollutionDrop >= 38 ? 'optimized' : emissions.pollutionDrop >= 22 ? 'trimming' : 'watch',
            flameTone: flame.orangeRatio >= 0.58 ? 'warm' : flame.orangeRatio <= 0.34 ? 'cool' : 'balanced',
            productSizeClass: productSpec.sizeClass,
        };
        const telemetry = {
            temp,
            temperature: temp,
            heat: derived.heat,
            thermal: clone(thermal),
            radiation_state: radiationState,
            radiationState,
            radiation: radiationState,
            radiationMode,
            radiation_mode: radiationMode,
            radiationIntensity,
            radiation_intensity: radiationIntensity,
            product_type: productType,
            productType,
            product: productType,
            productCount,
            product_count: productCount,
            productSpec: clone(productSpec),
            sizeRatio,
            size_ratio: sizeRatio,
            emissions: clone(emissions),
            pollutionDrop: emissions.pollutionDrop,
            pollution_drop: emissions.pollutionDrop,
            efficiency,
            efficiencyRatio,
            efficiency_ratio: efficiencyRatio,
            ambientTemp,
            ambient_temp: ambientTemp,
            humidity,
            environment: clone(environment),
            flame: clone(flame),
            derived: clone(derived),
        };

        return {
            timestamp,
            temp,
            temperature: temp,
            heat: derived.heat,
            thermal: clone(thermal),
            radiation_state: radiationState,
            radiationState,
            radiation: radiationState,
            radiationMode,
            radiation_mode: radiationMode,
            radiationIntensity,
            radiation_intensity: radiationIntensity,
            product_type: productType,
            productType,
            product: productType,
            productCount,
            product_count: productCount,
            sizeRatio,
            size_ratio: sizeRatio,
            productSpec: clone(productSpec),
            emissions: clone(emissions),
            pollutionDrop: emissions.pollutionDrop,
            pollution_drop: emissions.pollutionDrop,
            efficiency,
            efficiencyRatio,
            efficiency_ratio: efficiencyRatio,
            ambientTemp,
            ambient_temp: ambientTemp,
            humidity,
            environment: clone(environment),
            flame: clone(flame),
            derived: clone(derived),
            telemetry,
            meta: {
                schema: SCHEMA_VERSION,
                source: 'static-mock',
                transport: 'mock',
                module_key: moduleKey,
                module_label: moduleLabel,
            },
        };
    }

    function buildRawModules(now) {
        return [
            {
                key: 'full-process',
                label: 'Full Firing Sequence',
                intervalMs: 1350,
                loop: false,
                description: 'A complete firing sequence driven by 1088 → 1222 → 1160 → 1222 → 1285 → 1160, ending in the cooling state for 24 small ceramic pieces.',
                frames: [
                    { timestamp: now + 0, telemetry: { temperature: 1088, radiationState: 'steady', radiationMode: 'outward', productType: 'large', productCount: 2, productSpec: { sizeFactor: 1.12 }, radiationIntensity: 0.34, flame: { blueRatio: 0.72, orangeRatio: 0.28, intensity: 0.22 }, efficiency: 84.2, emissions: { CO2: 474, NOx: 29 }, ambientTemp: 24.1, humidity: 55 } },
                    { timestamp: now + 20, telemetry: { temperature: 1148, radiationState: 'steady', radiationMode: 'outward', productType: 'large', productCount: 2, productSpec: { sizeFactor: 1.1 }, radiationIntensity: 0.4, flame: { blueRatio: 0.66, orangeRatio: 0.34, intensity: 0.28 }, efficiency: 85.6, emissions: { CO2: 466, NOx: 28 }, ambientTemp: 24.4, humidity: 52 } },
                    { timestamp: now + 40, telemetry: { temperature: 1222, radiationState: 'steady', radiationMode: 'outward', productType: 'large', productCount: 2, productSpec: { sizeFactor: 1.08 }, radiationIntensity: 0.48, flame: { blueRatio: 0.6, orangeRatio: 0.4, intensity: 0.34 }, efficiency: 87.8, emissions: { CO2: 454, NOx: 27 }, ambientTemp: 24.8, humidity: 49 } },
                    { timestamp: now + 60, telemetry: { temperature: 1160, radiationState: 'weaken', radiationMode: 'inward', productType: 'small', productCount: 4, productSpec: { sizeFactor: 0.94 }, radiationIntensity: 0.32, flame: { blueRatio: 0.58, orangeRatio: 0.42, intensity: 0.26 }, efficiency: 88.4, emissions: { CO2: 446, NOx: 25 }, ambientTemp: 25, humidity: 46 } },
                    { timestamp: now + 80, telemetry: { temperature: 1192, radiationState: 'enhance', radiationMode: 'outward', productType: 'large', productCount: 8, productSpec: { sizeFactor: 1.02 }, radiationIntensity: 0.58, flame: { blueRatio: 0.5, orangeRatio: 0.5, intensity: 0.62 }, efficiency: 89.6, emissions: { CO2: 438, NOx: 28 }, ambientTemp: 25.3, humidity: 43 } },
                    { timestamp: now + 100, telemetry: { temperature: 1222, radiationState: 'enhance', radiationMode: 'outward', productType: 'large', productCount: 8, productSpec: { sizeFactor: 1 }, radiationIntensity: 0.68, flame: { blueRatio: 0.44, orangeRatio: 0.56, intensity: 0.78 }, efficiency: 91.2, emissions: { CO2: 430, NOx: 29 }, ambientTemp: 25.6, humidity: 40 } },
                    { timestamp: now + 120, telemetry: { temperature: 1254, radiationState: 'enhance', radiationMode: 'outward', productType: 'large', productCount: 8, productSpec: { sizeFactor: 0.99 }, radiationIntensity: 0.76, flame: { blueRatio: 0.36, orangeRatio: 0.64, intensity: 0.9 }, efficiency: 92.4, emissions: { CO2: 424, NOx: 30 }, ambientTemp: 25.9, humidity: 37 } },
                    { timestamp: now + 140, telemetry: { temperature: 1285, radiationState: 'enhance', radiationMode: 'outward', productType: 'large', productCount: 8, productSpec: { sizeFactor: 0.98 }, radiationIntensity: 0.82, flame: { blueRatio: 0.3, orangeRatio: 0.7, intensity: 1 }, efficiency: 93.4, emissions: { CO2: 418, NOx: 31 }, ambientTemp: 26.2, humidity: 35 } },
                    { timestamp: now + 160, telemetry: { temperature: 1230, radiationState: 'weaken', radiationMode: 'inward', productType: 'small', productCount: 24, productSpec: { sizeFactor: 0.9 }, radiationIntensity: 0.46, flame: { blueRatio: 0.46, orangeRatio: 0.54, intensity: 0.52 }, efficiency: 92.2, emissions: { CO2: 422, NOx: 26 }, ambientTemp: 25.8, humidity: 39 } },
                    { timestamp: now + 180, telemetry: { temperature: 1192, radiationState: 'weaken', radiationMode: 'inward', productType: 'small', productCount: 24, productSpec: { sizeFactor: 0.88 }, radiationIntensity: 0.38, flame: { blueRatio: 0.5, orangeRatio: 0.5, intensity: 0.42 }, efficiency: 91, emissions: { CO2: 428, NOx: 24 }, ambientTemp: 25.3, humidity: 44 } },
                    { timestamp: now + 200, telemetry: { temperature: 1160, radiationState: 'weaken', radiationMode: 'inward', productType: 'small', productCount: 24, productSpec: { sizeFactor: 0.86 }, radiationIntensity: 0.3, flame: { blueRatio: 0.54, orangeRatio: 0.46, intensity: 0.34 }, efficiency: 89.8, emissions: { CO2: 434, NOx: 23 }, ambientTemp: 24.9, humidity: 48 } },
                ],
            },
        ];
    }

    function buildModule(definition) {
        return {
            key: definition.key,
            label: definition.label,
            intervalMs: definition.intervalMs,
            loop: definition.loop !== false,
            description: definition.description,
            frames: definition.frames.map((frame) => buildFrame(definition.key, definition.label, frame)),
        };
    }

    const now = Math.floor(Date.now() / 1000);
    const RAW_MODULES = buildRawModules(now);
    const MODULES = RAW_MODULES.map((module) => buildModule(module));
    const DEFAULT_MODULE_KEY = 'full-process';

    const SCHEMA = Object.freeze({
        version: SCHEMA_VERSION,
        required: [
            'timestamp',
            'telemetry.temp',
            'telemetry.radiation_state',
            'telemetry.product_type',
            'telemetry.productCount',
            'telemetry.emissions.CO2',
            'telemetry.emissions.NOx',
            'telemetry.efficiency',
        ],
        optional: [
            'telemetry.temperature',
            'telemetry.radiationState',
            'telemetry.radiationMode',
            'telemetry.radiationIntensity',
            'telemetry.productType',
            'telemetry.productSpec.sizeFactor',
            'telemetry.sizeRatio',
            'telemetry.efficiencyRatio',
            'telemetry.pollutionDrop',
            'telemetry.flame.blueRatio',
            'telemetry.flame.orangeRatio',
            'telemetry.flame.intensity',
            'telemetry.ambientTemp',
            'telemetry.humidity',
            'telemetry.thermal.band',
            'telemetry.derived.temperatureBand',
        ],
        radiation_states: ['enhance', 'steady', 'weaken'],
        product_types: ['large', 'small'],
        units: {
            timestamp: 'unix_seconds',
            temp: 'degC',
            emissions_CO2: 'ppm',
            emissions_NOx: 'ppm',
            efficiency: 'percent',
            ambientTemp: 'degC',
            humidity: 'percent',
            flame_ratio: '0_to_1',
            radiation_intensity: '0_to_1',
        },
    });

    global.KilnTwinTelemetryMock = {
        version: VERSION,
        schema: SCHEMA,
        defaultModule: DEFAULT_MODULE_KEY,
        modules: clone(MODULES),
        getCatalog() {
            return {
                schema_version: SCHEMA.version,
                transport: 'mock',
                default_module: DEFAULT_MODULE_KEY,
                modules: clone(RAW_MODULES),
            };
        },
        getSequence(moduleKey) {
            const match = MODULES.find((module) => module.key === moduleKey) || MODULES[0];
            return clone(match.frames);
        },
        listModules() {
            return MODULES.map((module) => ({
                key: module.key,
                label: module.label,
                intervalMs: module.intervalMs,
                description: module.description,
            }));
        },
    };
}(window));
