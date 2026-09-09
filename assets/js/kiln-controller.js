(function (global) {
    'use strict';

    const VERSION = '0.2.0';
    const SCHEMA_VERSION = 'kiln.telemetry.v1';
    const DEFAULT_EVENT_NAMES = Object.freeze({
        telemetry: 'kiln:twin:telemetry',
        module: 'kiln:twin:module-change',
        status: 'kiln:twin:status',
    });

    function isPlainObject(value) {
        return Object.prototype.toString.call(value) === '[object Object]';
    }

    function clone(value) {
        if (value == null) return value;
        try {
            return JSON.parse(JSON.stringify(value));
        } catch (error) {
            return value;
        }
    }

    function clamp(value, min, max) {
        return Math.min(max, Math.max(min, value));
    }

    function toFiniteNumber(value, fallback) {
        const number = Number(value);
        return Number.isFinite(number) ? number : fallback;
    }

    function round(value, digits) {
        const factor = Math.pow(10, digits);
        return Math.round(value * factor) / factor;
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

    const TEMPERATURE_LIMITS = Object.freeze({
        inputMin: 800,
        inputMax: 1450,
        profileMin: 913,
        profileMax: 1361,
    });
    const PRODUCT_COUNT_LIMITS = Object.freeze({
        large: { min: 2, max: 24, fallback: 12 },
        small: { min: 4, max: 48, fallback: 36 },
    });

    function normalizeTimestamp(rawValue, fallbackValue) {
        if (rawValue instanceof Date) {
            return Math.floor(rawValue.getTime() / 1000);
        }
        if (typeof rawValue === 'string' && rawValue.trim()) {
            const parsed = Date.parse(rawValue);
            if (Number.isFinite(parsed)) {
                return Math.floor(parsed / 1000);
            }
        }
        if (Number.isFinite(Number(rawValue))) {
            const numeric = Number(rawValue);
            if (numeric > 100000000000) {
                return Math.floor(numeric / 1000);
            }
            return Math.floor(numeric);
        }
        return Math.floor(fallbackValue || Date.now() / 1000);
    }

    function toUnitInterval(value, fallback) {
        const numeric = toFiniteNumber(value, fallback);
        if (!Number.isFinite(numeric)) return fallback;
        if (numeric > 1) return clamp(numeric / 100, 0, 1);
        return clamp(numeric, 0, 1);
    }

    function normalizeTemperature(rawValue, fallbackValue) {
        return round(
            clamp(
                toFiniteNumber(rawValue, toFiniteNumber(fallbackValue, 1180)),
                TEMPERATURE_LIMITS.inputMin,
                TEMPERATURE_LIMITS.inputMax
            ),
            1
        );
    }

    function deriveHeatUnit(temp) {
        return clamp(
            (temp - TEMPERATURE_LIMITS.profileMin) / (TEMPERATURE_LIMITS.profileMax - TEMPERATURE_LIMITS.profileMin),
            0,
            1
        );
    }

    function deriveTemperatureBand(temp) {
        if (temp >= 1275) return 'high-fire';
        if (temp >= 1215) return 'holding';
        if (temp >= 1140) return 'ramp';
        return 'preheat';
    }

    function normalizeRadiationState(rawValue, temperature) {
        const value = String(rawValue || '').trim().toLowerCase();
        if (['enhance', 'enhanced', 'boost', 'high', 'up', 'inward', 'focus', 'strong'].includes(value)) {
            return 'enhance';
        }
        if (['weaken', 'weakened', 'weak', 'low', 'down', 'outward', 'bleed'].includes(value)) {
            return 'weaken';
        }
        if (['steady', 'stable', 'hold', 'normal', 'balanced', 'auto'].includes(value)) {
            return 'steady';
        }
        if (temperature >= 1205) return 'enhance';
        if (temperature <= 1165) return 'weaken';
        return 'steady';
    }

    function normalizeRadiationMode(rawValue, radiationState) {
        const value = String(rawValue || '').trim().toLowerCase();
        if (['inward', 'enhance', 'enhanced', 'focus', 'strong'].includes(value)) return 'inward';
        if (['outward', 'weaken', 'weakened', 'bleed', 'weak'].includes(value)) return 'outward';
        if (['auto', 'steady', 'stable', 'hold', 'normal'].includes(value)) return 'auto';
        if (radiationState === 'enhance') return 'inward';
        if (radiationState === 'weaken') return 'outward';
        return 'auto';
    }

    function normalizeProductType(rawValue, temperature) {
        const value = String(rawValue || '').trim().toLowerCase();
        if (value === 'large' || value === 'small') return value;
        return temperature >= 1210 ? 'small' : 'large';
    }

    function normalizeProductCount(rawValue, productType, fallbackValue) {
        const limits = PRODUCT_COUNT_LIMITS[productType === 'small' ? 'small' : 'large'];
        const fallback = toFiniteNumber(fallbackValue, limits.fallback);
        return Math.round(clamp(toFiniteNumber(rawValue, fallback), limits.min, limits.max));
    }

    function normalizeAmbientTemp(rawValue, fallbackValue) {
        return round(clamp(toFiniteNumber(rawValue, toFiniteNumber(fallbackValue, 25)), -20, 80), 1);
    }

    function normalizeHumidity(rawValue, fallbackValue) {
        return round(clamp(toFiniteNumber(rawValue, toFiniteNumber(fallbackValue, 45)), 0, 100), 1);
    }

    function deriveProductSizeRatio(temp, productType) {
        const normalized = deriveHeatUnit(temp);
        const minScale = productType === 'large' ? 0.7 : 0.82;
        const maxScale = productType === 'large' ? 1.2 : 1.12;
        return round(maxScale + ((minScale - maxScale) * normalized), 3);
    }

    function normalizeSizeRatio(rawValue, temp, productType) {
        return round(clamp(toFiniteNumber(rawValue, deriveProductSizeRatio(temp, productType)), 0.4, 1.6), 3);
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

    function normalizeEfficiency(rawValue, ratioValue, temp, radiationState, productType, fallbackValue) {
        const derived = deriveEfficiencyPercent(temp, radiationState, productType);
        const fallback = toFiniteNumber(fallbackValue, derived);
        const value = firstDefined(rawValue, ratioValue);
        const normalized = value === ratioValue
            ? toUnitInterval(value, fallback / 100) * 100
            : toFiniteNumber(value, fallback);
        return round(clamp(normalized, 0, 100), 1);
    }

    function derivePollutionDrop(emissions) {
        const co2Lift = clamp((520 - emissions.CO2) / 2.4, 0, 65);
        const noxLift = clamp((50 - emissions.NOx) * 1.75, 0, 35);
        return round(clamp((co2Lift * 0.65) + (noxLift * 0.35), 0, 100), 1);
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
            orangeRatio: round(orangeRatio, 3),
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

    function deriveEmissionState(pollutionDrop) {
        if (pollutionDrop >= 38) return 'optimized';
        if (pollutionDrop >= 22) return 'trimming';
        return 'watch';
    }

    function deriveFlameTone(orangeRatio) {
        if (orangeRatio >= 0.58) return 'warm';
        if (orangeRatio <= 0.34) return 'cool';
        return 'balanced';
    }

    function deriveProductSizeClass(sizeRatio) {
        if (sizeRatio >= 1.08) return 'expanded';
        if (sizeRatio <= 0.92) return 'compact';
        return 'nominal';
    }

    function normalizeEmissions(emissionsRoot, telemetryRoot, root, previousEmissions, temp, efficiency, productType, radiationState) {
        const baseline = deriveEmissionBaseline(temp, efficiency, productType, radiationState);
        const explicitDrop = toFiniteNumber(
            firstDefined(
                emissionsRoot.pollutionDrop,
                emissionsRoot.pollution_drop,
                telemetryRoot.pollutionDrop,
                telemetryRoot.pollution_drop,
                root.pollutionDrop,
                root.pollution_drop
            ),
            undefined
        );

        let co2 = toFiniteNumber(
            firstDefined(emissionsRoot.CO2, emissionsRoot.co2, previousEmissions.CO2, previousEmissions.co2),
            undefined
        );
        let nox = toFiniteNumber(
            firstDefined(emissionsRoot.NOx, emissionsRoot.nox, previousEmissions.NOx, previousEmissions.nox),
            undefined
        );

        if (Number.isFinite(explicitDrop)) {
            const targetDrop = clamp(explicitDrop, 0, 100);
            if (!Number.isFinite(nox)) {
                nox = baseline.NOx;
            }
            if (!Number.isFinite(co2)) {
                const noxScore = clamp((50 - nox) * 1.75, 0, 35);
                const co2Score = clamp((targetDrop - (noxScore * 0.35)) / 0.65, 0, 65);
                co2 = 520 - (co2Score * 2.4);
            }
            if (!Number.isFinite(nox)) {
                const co2Score = clamp((520 - co2) / 2.4, 0, 65);
                const noxScore = clamp((targetDrop - (co2Score * 0.65)) / 0.35, 0, 35);
                nox = 50 - (noxScore / 1.75);
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

    function buildFallbackModules(now) {
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

    function normalizeTelemetryPayload(payload, context) {
        const fallbackTimestamp = context?.fallbackTimestamp || Date.now() / 1000;
        const root = isPlainObject(payload) ? payload : {};
        const telemetryRoot = isPlainObject(root.telemetry) ? root.telemetry : root;
        const thermalRoot = isPlainObject(telemetryRoot.thermal)
            ? telemetryRoot.thermal
            : (isPlainObject(root.thermal) ? root.thermal : {});
        const environmentRoot = isPlainObject(telemetryRoot.environment)
            ? telemetryRoot.environment
            : (isPlainObject(root.environment) ? root.environment : {});
        const productRoot = isPlainObject(telemetryRoot.product)
            ? telemetryRoot.product
            : (isPlainObject(root.product) ? root.product : {});
        const productSpecRoot = isPlainObject(telemetryRoot.productSpec)
            ? telemetryRoot.productSpec
            : (isPlainObject(root.productSpec) ? root.productSpec : {});
        const emissionsRoot = isPlainObject(telemetryRoot.emissions)
            ? telemetryRoot.emissions
            : (isPlainObject(root.emissions) ? root.emissions : {});
        const flameRoot = isPlainObject(telemetryRoot.flame)
            ? telemetryRoot.flame
            : (isPlainObject(root.flame) ? root.flame : {});

        const previousPayload = context?.previousTelemetry || {};
        const previousTelemetry = isPlainObject(previousPayload.telemetry)
            ? previousPayload.telemetry
            : previousPayload;
        const previousEnvironment = isPlainObject(previousTelemetry.environment)
            ? previousTelemetry.environment
            : {};
        const previousEmissions = isPlainObject(previousTelemetry.emissions)
            ? previousTelemetry.emissions
            : {};
        const temp = normalizeTemperature(
            firstDefined(
                telemetryRoot.temp,
                telemetryRoot.temperature,
                root.temp,
                root.temperature,
                thermalRoot.temp,
                thermalRoot.temperature,
                previousTelemetry.temp,
                previousTelemetry.temperature
            ),
            1180
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
                productRoot.productType,
                productSpecRoot.type,
                productSpecRoot.productType,
                productSpecRoot.product_type,
                previousTelemetry.productType,
                previousTelemetry.product_type,
                previousTelemetry.product
            ),
            temp
        );

        const radiationState = normalizeRadiationState(
            firstDefined(
                telemetryRoot.radiationState,
                telemetryRoot.radiation_state,
                typeof telemetryRoot.radiation === 'string' ? telemetryRoot.radiation : undefined,
                root.radiationState,
                root.radiation_state,
                typeof root.radiation === 'string' ? root.radiation : undefined,
                thermalRoot.radiationState,
                thermalRoot.radiation_state,
                previousTelemetry.radiationState,
                previousTelemetry.radiation_state,
                previousTelemetry.radiation
            ),
            temp
        );

        const productCount = normalizeProductCount(
            firstDefined(
                telemetryRoot.productCount,
                telemetryRoot.product_count,
                root.productCount,
                root.product_count,
                productRoot.count,
                productRoot.productCount,
                productSpecRoot.count,
                productSpecRoot.productCount,
                productSpecRoot.product_count,
                previousTelemetry.productCount,
                previousTelemetry.product_count
            ),
            productType,
            previousTelemetry.productCount
        );

        const sizeRatio = normalizeSizeRatio(
            firstDefined(
                telemetryRoot.sizeRatio,
                telemetryRoot.size_ratio,
                root.sizeRatio,
                root.size_ratio,
                productRoot.sizeRatio,
                productRoot.size_ratio,
                productSpecRoot.sizeRatio,
                productSpecRoot.size_ratio,
                productSpecRoot.sizeFactor,
                productSpecRoot.size_factor
            ),
            temp,
            productType
        );

        const efficiency = normalizeEfficiency(
            firstDefined(
                telemetryRoot.efficiency,
                root.efficiency,
                thermalRoot.efficiency,
                previousTelemetry.efficiency
            ),
            firstDefined(
                telemetryRoot.efficiencyRatio,
                telemetryRoot.efficiency_ratio,
                root.efficiencyRatio,
                root.efficiency_ratio,
                thermalRoot.efficiencyRatio,
                thermalRoot.efficiency_ratio
            ),
            temp,
            radiationState,
            productType,
            previousTelemetry.efficiency
        );
        const efficiencyRatio = round(clamp(efficiency / 100, 0, 1), 3);

        const radiationMode = normalizeRadiationMode(
            firstDefined(
                telemetryRoot.radiationMode,
                telemetryRoot.radiation_mode,
                root.radiationMode,
                root.radiation_mode,
                thermalRoot.radiationMode,
                thermalRoot.radiation_mode,
                previousTelemetry.radiationMode,
                previousTelemetry.radiation_mode
            ),
            radiationState
        );
        const radiationIntensity = round(
            clamp(
                toUnitInterval(
                    firstDefined(
                        telemetryRoot.radiationIntensity,
                        telemetryRoot.radiation_intensity,
                        root.radiationIntensity,
                        root.radiation_intensity,
                        thermalRoot.radiationIntensity,
                        thermalRoot.radiation_intensity
                    ),
                    deriveRadiationIntensity(temp, radiationState, efficiency)
                ),
                0,
                1
            ),
            3
        );

        const emissions = normalizeEmissions(
            emissionsRoot,
            telemetryRoot,
            root,
            previousEmissions,
            temp,
            efficiency,
            productType,
            radiationState
        );

        const ambientTemp = normalizeAmbientTemp(
            firstDefined(
                telemetryRoot.ambientTemp,
                telemetryRoot.ambient_temp,
                root.ambientTemp,
                root.ambient_temp,
                environmentRoot.ambientTemp,
                environmentRoot.ambient_temp,
                environmentRoot.temperature,
                previousTelemetry.ambientTemp,
                previousEnvironment.ambientTemp
            ),
            25
        );

        const humidity = normalizeHumidity(
            firstDefined(
                telemetryRoot.humidity,
                root.humidity,
                environmentRoot.humidity,
                previousTelemetry.humidity,
                previousEnvironment.humidity
            ),
            45
        );

        const flame = normalizeFlameProfile(
            flameRoot,
            deriveFlameProfile(temp, radiationState, radiationIntensity)
        );

        const timestamp = normalizeTimestamp(
            firstDefined(root.timestamp, telemetryRoot.timestamp),
            fallbackTimestamp
        );

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
            sizeClass: deriveProductSizeClass(sizeRatio),
        };
        const environment = {
            ambientTemp,
            ambient_temp: ambientTemp,
            humidity,
        };
        const thermal = {
            temp,
            temperature: temp,
            band: deriveTemperatureBand(temp),
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
        const derived = {
            heat: round(deriveHeatUnit(temp), 3),
            temperatureBand: thermal.band,
            radiationMode,
            radiationIntensity,
            efficiencyRatio,
            pollutionDrop: emissions.pollutionDrop,
            emissionState: deriveEmissionState(emissions.pollutionDrop),
            flameTone: deriveFlameTone(flame.orangeRatio),
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
            product_type: productType,
            productType,
            product: productType,
            radiationMode,
            radiation_mode: radiationMode,
            radiationIntensity,
            radiation_intensity: radiationIntensity,
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
            efficiency,
            pollutionDrop: emissions.pollutionDrop,
            pollution_drop: emissions.pollutionDrop,
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
                source: context?.source || root.meta?.source || 'manual',
                transport: context?.transportType || root.meta?.transport || null,
                module_key: context?.moduleKey || root.meta?.module_key || root.meta?.moduleKey || root.module_key || root.moduleKey || null,
                module_label: context?.moduleLabel || root.meta?.module_label || root.meta?.moduleLabel || root.module_label || root.moduleLabel || null,
            },
        };
    }

    function createFallbackCatalog() {
        const now = Math.floor(Date.now() / 1000);
        return {
            default_module: 'full-process',
            modules: buildFallbackModules(now),
        };
    }

    function getMockProviderCatalog() {
        const provider = global.KilnTwinTelemetryMock;
        if (provider && typeof provider.getCatalog === 'function') {
            return provider.getCatalog();
        }
        if (provider && Array.isArray(provider.modules)) {
            return {
                default_module: provider.defaultModule || provider.modules[0]?.key || null,
                modules: clone(provider.modules),
            };
        }
        return createFallbackCatalog();
    }

    function normalizeCatalog(rawCatalog) {
        const catalogRoot = Array.isArray(rawCatalog)
            ? { modules: rawCatalog, default_module: rawCatalog[0]?.key || null }
            : (isPlainObject(rawCatalog) ? rawCatalog : {});
        const rawModules = Array.isArray(catalogRoot.modules) ? catalogRoot.modules : [];
        const now = Math.floor(Date.now() / 1000);

        const modules = rawModules.map((entry, moduleIndex) => {
            const key = String(entry.key || entry.module_key || `module-${moduleIndex + 1}`).trim();
            const label = String(entry.label || entry.module_label || key).trim();
            const framesSource = Array.isArray(entry.frames)
                ? entry.frames
                : (Array.isArray(entry.payloads) ? entry.payloads : []);
            const intervalMs = Math.max(
                250,
                Math.floor(toFiniteNumber(entry.intervalMs ?? entry.interval_ms, 1500))
            );

            let previousFrame = null;
            const frames = framesSource.map((frame, frameIndex) => {
                const normalized = normalizeTelemetryPayload(frame, {
                    source: frame?.meta?.source || entry.source || 'mock',
                    transportType: entry.transport || catalogRoot.transport || null,
                    moduleKey: key,
                    moduleLabel: label,
                    fallbackTimestamp: now + (moduleIndex * 120) + (frameIndex * 20),
                    previousTelemetry: previousFrame,
                });
                previousFrame = normalized;
                return normalized;
            });

            return {
                key,
                label,
                intervalMs,
                loop: entry.loop !== false,
                description: String(entry.description || '').trim(),
                frames,
            };
        }).filter((module) => module.frames.length > 0);

        const requestedDefault = String(
            catalogRoot.default_module || catalogRoot.defaultModule || modules[0]?.key || ''
        ).trim();
        const defaultModule = modules.some((module) => module.key === requestedDefault)
            ? requestedDefault
            : (modules[0]?.key || null);

        return { defaultModule, modules };
    }

    function dispatchEvent(target, name, detail) {
        if (!target || typeof target.dispatchEvent !== 'function' || typeof global.CustomEvent !== 'function') {
            return;
        }
        target.dispatchEvent(new global.CustomEvent(name, { detail }));
    }

    function invokeTarget(target, payload, detail) {
        if (!target) return;
        try {
            if (typeof target === 'function') {
                target(payload, detail);
                return;
            }
            if (typeof target.updateTelemetry === 'function') {
                target.updateTelemetry(payload, detail);
                return;
            }
            if (typeof target.applyTelemetry === 'function' && target !== detail.controller) {
                target.applyTelemetry(payload, detail);
            }
        } catch (error) {
            console.warn('[KilnTwinController] telemetry target failed', error);
        }
    }

    function uniqueTargets(targets) {
        const seen = new Set();
        return targets.filter((target) => {
            if (!target || seen.has(target)) return false;
            seen.add(target);
            return true;
        });
    }

    async function fetchCatalog(url, signal) {
        if (typeof global.fetch !== 'function' || !url) return null;
        const response = await global.fetch(url, {
            method: 'GET',
            headers: {
                'Accept': 'application/json',
            },
            signal,
        });
        if (!response.ok) {
            throw new Error(`Telemetry fetch failed: ${response.status}`);
        }
        return response.json();
    }

    function resolveWebSocketConfig(transport) {
        const websocketRoot = isPlainObject(transport?.websocket) ? transport.websocket : {};
        const url = firstDefined(
            transport?.websocketUrl,
            transport?.wsUrl,
            transport?.socketUrl,
            websocketRoot.url
        );
        if (!url || typeof global.WebSocket !== 'function') {
            return null;
        }
        return {
            url,
            protocols: firstDefined(transport?.protocols, websocketRoot.protocols),
            connectTimeoutMs: Math.max(
                250,
                Math.floor(
                    toFiniteNumber(
                        firstDefined(transport?.connectTimeoutMs, websocketRoot.connectTimeoutMs),
                        3000
                    )
                )
            ),
            parser: typeof transport?.parseMessage === 'function'
                ? transport.parseMessage
                : (typeof websocketRoot.parseMessage === 'function' ? websocketRoot.parseMessage : null),
        };
    }

    function parseWebSocketMessage(rawData, parser) {
        if (typeof parser === 'function') {
            return parser(rawData);
        }

        if (typeof rawData === 'string') {
            return JSON.parse(rawData);
        }

        if (rawData instanceof ArrayBuffer && typeof global.TextDecoder === 'function') {
            const decoder = new global.TextDecoder('utf-8');
            return JSON.parse(decoder.decode(rawData));
        }

        return rawData;
    }

    function create(options) {
        const settings = isPlainObject(options) ? options : {};
        const transport = {
            type: 'mock',
            url: '/api/telemetry/mock',
            autoPlay: true,
            intervalMs: 1500,
            ...(isPlainObject(settings.transport) ? settings.transport : {}),
        };
        const state = {
            destroyed: false,
            connected: false,
            isPlaying: false,
            status: 'idle',
            catalog: [],
            moduleKey: null,
            moduleLabel: null,
            frameIndex: 0,
            timerId: null,
            lastTelemetry: null,
            cleanup: null,
            pendingConnect: null,
            abortController: null,
            moduleState: Object.create(null),
            transportMode: 'catalog',
            bufferedWhilePaused: false,
        };

        function getEventTarget() {
            return settings.eventTarget || global;
        }

        function getTargets() {
            return uniqueTargets([
                settings.scene,
                settings.overlays,
                settings.dashboard,
                settings.ui,
                ...(Array.isArray(settings.targets) ? settings.targets : []),
            ]);
        }

        function currentModule() {
            return state.catalog.find((entry) => entry.key === state.moduleKey) || null;
        }

        function ensureModuleRuntime(moduleKey) {
            const key = String(moduleKey || '').trim();
            if (!key) return null;
            if (!state.moduleState[key]) {
                state.moduleState[key] = {
                    nextFrameIndex: 0,
                    lastFrameIndex: null,
                    lastTelemetry: null,
                    isTerminalFrame: false,
                };
            }
            return state.moduleState[key];
        }

        function getState() {
            return {
                connected: state.connected,
                destroyed: state.destroyed,
                isPlaying: state.isPlaying,
                status: state.status,
                moduleKey: state.moduleKey,
                moduleLabel: state.moduleLabel,
                frameIndex: state.frameIndex,
                lastTelemetry: clone(state.lastTelemetry),
            };
        }

        function emitStatus(reason, extra) {
            state.status = reason;
            const detail = {
                ...getState(),
                reason,
                ...(isPlainObject(extra) ? extra : {}),
            };
            if (typeof settings.onStatusChange === 'function') {
                settings.onStatusChange(detail);
            }
            dispatchEvent(getEventTarget(), DEFAULT_EVENT_NAMES.status, detail);
            return detail;
        }

        function emitModuleChange(reason) {
            const detail = {
                moduleKey: state.moduleKey,
                moduleLabel: state.moduleLabel,
                reason: reason || 'module-change',
                modules: api.listModules(),
            };
            if (typeof settings.onModuleChange === 'function') {
                settings.onModuleChange(detail);
            }
            dispatchEvent(getEventTarget(), DEFAULT_EVENT_NAMES.module, detail);
            return detail;
        }

        function stopPlayback() {
            if (state.timerId != null) {
                global.clearInterval(state.timerId);
                state.timerId = null;
            }
            state.isPlaying = false;
        }

        function readInlineCatalogDefinition() {
            if (Array.isArray(settings.modules)) {
                return {
                    default_module: settings.moduleKey || settings.modules[0]?.key || null,
                    modules: settings.modules,
                };
            }

            if (Array.isArray(transport.modules)) {
                return {
                    default_module: transport.moduleKey || transport.modules[0]?.key || null,
                    modules: transport.modules,
                };
            }

            if (Array.isArray(transport.payloads)) {
                return {
                    default_module: 'runtime',
                    modules: [{
                        key: 'runtime',
                        label: 'Live Data Stream',
                        intervalMs: transport.intervalMs,
                        frames: transport.payloads,
                    }],
                };
            }

            return null;
        }

        function seedLiveCatalog() {
            const inlineCatalog = readInlineCatalogDefinition();
            if (inlineCatalog) {
                const normalized = normalizeCatalog(inlineCatalog);
                state.catalog = normalized.modules;
                const preferredModule = state.catalog.find((entry) => entry.key === normalized.defaultModule)
                    || state.catalog[0]
                    || null;
                if (preferredModule) {
                    state.moduleKey = preferredModule.key;
                    state.moduleLabel = preferredModule.label;
                    ensureModuleRuntime(preferredModule.key);
                }
                return preferredModule;
            }

            const fallbackKey = String(
                state.moduleKey || transport.moduleKey || settings.moduleKey || 'runtime'
            ).trim() || 'runtime';
            const fallbackLabel = String(
                state.moduleLabel || transport.moduleLabel || 'Live Data Stream'
            ).trim() || fallbackKey;
            const existing = state.catalog.find((entry) => entry.key === fallbackKey);
            if (!existing) {
                state.catalog = [{
                    key: fallbackKey,
                    label: fallbackLabel,
                    intervalMs: Math.max(250, Math.floor(toFiniteNumber(transport.intervalMs, 1500))),
                    description: 'Real-time telemetry stream.',
                    frames: [],
                }];
            }
            state.moduleKey = fallbackKey;
            state.moduleLabel = fallbackLabel;
            ensureModuleRuntime(fallbackKey);
            return state.catalog.find((entry) => entry.key === fallbackKey) || null;
        }

        function fanOut(payload, reason) {
            const detail = {
                controller: api,
                payload: clone(payload),
                reason: reason || 'update',
                moduleKey: state.moduleKey,
                moduleLabel: state.moduleLabel,
            };
            getTargets().forEach((target) => invokeTarget(target, payload, detail));
            if (typeof settings.onTelemetry === 'function') {
                settings.onTelemetry(payload, detail);
            }

            const telemetryEventName = settings.eventName || DEFAULT_EVENT_NAMES.telemetry;
            dispatchEvent(getEventTarget(), telemetryEventName, detail);
            if (telemetryEventName !== DEFAULT_EVENT_NAMES.telemetry) {
                dispatchEvent(getEventTarget(), DEFAULT_EVENT_NAMES.telemetry, detail);
            }
            return detail;
        }

        function rememberModuleTelemetry(moduleKey, payload, applyOptions) {
            const runtime = ensureModuleRuntime(moduleKey);
            if (!runtime) return;
            const module = state.catalog.find((entry) => entry.key === moduleKey) || null;
            const options = isPlainObject(applyOptions) ? applyOptions : {};
            runtime.lastTelemetry = clone(payload);
            if (Number.isInteger(options.frameIndex)) {
                runtime.lastFrameIndex = options.frameIndex;
                if (!options.preserveCursor && module?.frames?.length) {
                    runtime.nextFrameIndex = module.loop === false
                        ? Math.min(options.frameIndex + 1, module.frames.length - 1)
                        : (options.frameIndex + 1) % module.frames.length;
                    runtime.isTerminalFrame = module.loop === false
                        && options.frameIndex >= module.frames.length - 1;
                }
            }
        }

        function applyTelemetry(rawPayload, applyOptions) {
            const options = isPlainObject(applyOptions) ? applyOptions : {};
            const normalized = normalizeTelemetryPayload(rawPayload, {
                source: options.source || rawPayload?.meta?.source || 'manual',
                transportType: options.transportType || transport.type || null,
                moduleKey: options.moduleKey || state.moduleKey,
                moduleLabel: options.moduleLabel || state.moduleLabel,
                fallbackTimestamp: options.timestamp || Date.now() / 1000,
                previousTelemetry: options.previousTelemetry || state.lastTelemetry,
            });
            const nextModuleKey = normalized.meta?.module_key || options.moduleKey || state.moduleKey;
            const nextModuleLabel = normalized.meta?.module_label || options.moduleLabel || state.moduleLabel;
            const didModuleChange = !!nextModuleKey && nextModuleKey !== state.moduleKey;

            if (nextModuleKey) {
                state.moduleKey = nextModuleKey;
                ensureModuleRuntime(nextModuleKey);
            }
            if (nextModuleLabel) {
                state.moduleLabel = nextModuleLabel;
            }

            state.lastTelemetry = normalized;
            state.frameIndex = Number.isInteger(options.frameIndex) ? options.frameIndex : state.frameIndex;
            rememberModuleTelemetry(
                normalized.meta?.module_key || options.moduleKey || state.moduleKey,
                normalized,
                options
            );

            if (didModuleChange && options.emitModuleChange !== false) {
                emitModuleChange(options.reason || 'telemetry-module');
            }

            if (options.deferFanOutWhenPaused && !state.isPlaying) {
                state.bufferedWhilePaused = true;
                return clone(normalized);
            }

            state.bufferedWhilePaused = false;
            fanOut(normalized, options.reason || 'manual');
            return clone(normalized);
        }

        function flushBufferedTelemetry(reason) {
            if (!state.bufferedWhilePaused || !state.lastTelemetry) return null;
            state.bufferedWhilePaused = false;
            return fanOut(state.lastTelemetry, reason || 'resume');
        }

        function emitCurrentFrame(reason, emitOptions) {
            const module = currentModule();
            if (!module || !module.frames.length) return null;
            const runtime = ensureModuleRuntime(module.key);
            const options = isPlainObject(emitOptions) ? emitOptions : {};
            const nextIndex = Number.isInteger(options.frameIndex)
                ? options.frameIndex
                : runtime?.nextFrameIndex ?? 0;
            const safeIndex = module.loop === false
                ? clamp(nextIndex, 0, module.frames.length - 1)
                : ((nextIndex % module.frames.length) + module.frames.length) % module.frames.length;
            const frame = module.frames[safeIndex];
            state.frameIndex = safeIndex;
            return applyTelemetry(frame, {
                source: frame.meta?.source || 'mock',
                transportType: transport.type || 'mock',
                moduleKey: module.key,
                moduleLabel: module.label,
                reason: reason || 'playback',
                frameIndex: safeIndex,
            });
        }

        function emitModuleSnapshot(module, reason) {
            const runtime = ensureModuleRuntime(module?.key);
            if (!module) return null;
            if (runtime?.lastTelemetry) {
                state.frameIndex = Number.isInteger(runtime.lastFrameIndex) ? runtime.lastFrameIndex : 0;
                return applyTelemetry(runtime.lastTelemetry, {
                    source: runtime.lastTelemetry.meta?.source || 'mock',
                    transportType: transport.type || 'mock',
                    moduleKey: module.key,
                    moduleLabel: module.label,
                    reason: reason || 'module-preview',
                    frameIndex: runtime.lastFrameIndex,
                    preserveCursor: true,
                });
            }
            return emitCurrentFrame(reason || 'module-preview', { frameIndex: runtime?.nextFrameIndex ?? 0 });
        }

        function schedulePlayback() {
            const module = currentModule();
            if (!module) return false;
            stopPlayback();
            state.isPlaying = true;
            state.timerId = global.setInterval(() => {
                const activeModule = currentModule();
                const runtime = ensureModuleRuntime(activeModule?.key);
                if (activeModule?.loop === false && runtime?.isTerminalFrame) {
                    stopPlayback();
                    emitStatus('paused', { moduleKey: state.moduleKey, moduleLabel: state.moduleLabel });
                    return;
                }
                emitCurrentFrame('playback');
            }, module.intervalMs || transport.intervalMs || 1500);
            return true;
        }

        async function loadCatalog() {
            const inlineCatalog = readInlineCatalogDefinition();
            if (inlineCatalog) {
                return normalizeCatalog(inlineCatalog);
            }

            if (transport.url) {
                try {
                    state.abortController = typeof global.AbortController === 'function'
                        ? new global.AbortController()
                        : null;
                    const response = await fetchCatalog(
                        transport.url,
                        state.abortController?.signal
                    );
                    state.abortController = null;
                    return normalizeCatalog(response);
                } catch (error) {
                    state.abortController = null;
                    console.warn('[KilnTwinController] mock endpoint unavailable, falling back to local mock.', error);
                }
            }

            return normalizeCatalog(getMockProviderCatalog());
        }

        function setModule(nextModuleKey, moduleOptions) {
            const options = isPlainObject(moduleOptions) ? moduleOptions : {};
            const nextKey = String(nextModuleKey || '').trim();
            const nextModule = state.catalog.find((entry) => entry.key === nextKey)
                || state.catalog[0]
                || null;
            if (!nextModule) return null;

            const resume = options.resume ?? state.isPlaying;
            stopPlayback();
            state.moduleKey = nextModule.key;
            state.moduleLabel = nextModule.label;
            state.frameIndex = ensureModuleRuntime(nextModule.key)?.lastFrameIndex ?? 0;
            emitModuleChange(options.reason || 'set-module');

            if (options.emit !== false) {
                emitModuleSnapshot(nextModule, options.reason || 'module-preview');
            }

            if (resume && options.autoPlay !== false) {
                schedulePlayback();
                emitStatus('playing', { moduleKey: state.moduleKey, moduleLabel: state.moduleLabel });
            }
            return getState();
        }

        async function attachTransportAdapter() {
            if (typeof transport.connect !== 'function') return false;

            try {
                const cleanup = await transport.connect({
                    controller: api,
                    schema: api.getSchema(),
                    applyTelemetry(payload, adapterOptions) {
                        const nextOptions = isPlainObject(adapterOptions) ? adapterOptions : {};
                        return applyTelemetry(payload, {
                            ...nextOptions,
                            source: nextOptions.source || transport.type || 'adapter',
                            transportType: nextOptions.transportType || transport.type || 'adapter',
                            deferFanOutWhenPaused: nextOptions.deferFanOutWhenPaused ?? true,
                        });
                    },
                    setModule,
                    getState,
                });
                state.cleanup = typeof cleanup === 'function' ? cleanup : null;
                state.transportMode = 'push';
                return true;
            } catch (error) {
                state.cleanup = null;
                state.transportMode = 'catalog';
                console.warn('[KilnTwinController] transport connect failed, falling back to mock.', error);
                return false;
            }
        }

        async function attachWebSocketTransport() {
            const wsConfig = resolveWebSocketConfig(transport);
            if (!wsConfig) return false;

            try {
                await new Promise((resolve, reject) => {
                    let settled = false;
                    const protocols = Array.isArray(wsConfig.protocols) || typeof wsConfig.protocols === 'string'
                        ? wsConfig.protocols
                        : undefined;
                    const socket = protocols !== undefined
                        ? new global.WebSocket(wsConfig.url, protocols)
                        : new global.WebSocket(wsConfig.url);
                    let timeoutId = null;

                    function finalize(callback) {
                        if (settled) return;
                        settled = true;
                        if (timeoutId != null) {
                            global.clearTimeout(timeoutId);
                            timeoutId = null;
                        }
                        callback();
                    }

                    function closeSocket() {
                        try {
                            socket.close();
                        } catch (error) {
                            console.warn('[KilnTwinController] websocket close failed', error);
                        }
                    }

                    socket.addEventListener('open', () => {
                        finalize(() => {
                            state.cleanup = () => closeSocket();
                            state.transportMode = 'push';

                            socket.addEventListener('message', (event) => {
                                try {
                                    const payload = parseWebSocketMessage(event.data, wsConfig.parser);
                                    if (payload == null) return;
                                    applyTelemetry(payload, {
                                        source: 'ws',
                                        transportType: transport.type || 'ws',
                                        reason: 'transport-message',
                                        deferFanOutWhenPaused: true,
                                    });
                                } catch (error) {
                                    console.warn('[KilnTwinController] websocket payload parse failed', error);
                                }
                            });

                            socket.addEventListener('close', () => {
                                if (state.destroyed) return;
                                state.connected = false;
                                stopPlayback();
                            });

                            resolve(true);
                        });
                    }, { once: true });

                    socket.addEventListener('error', () => {
                        finalize(() => {
                            closeSocket();
                            reject(new Error('WebSocket connection failed.'));
                        });
                    }, { once: true });

                    timeoutId = global.setTimeout(() => {
                        finalize(() => {
                            closeSocket();
                            reject(new Error('WebSocket connection timed out.'));
                        });
                    }, wsConfig.connectTimeoutMs);
                });

                return true;
            } catch (error) {
                state.cleanup = null;
                state.transportMode = 'catalog';
                console.warn('[KilnTwinController] websocket unavailable, falling back to mock.', error);
                return false;
            }
        }

        async function connect() {
            if (state.destroyed) {
                throw new Error('KilnTwinController has been destroyed.');
            }
            if (state.pendingConnect) {
                return state.pendingConnect;
            }
            if (state.connected) {
                return getState();
            }

            state.pendingConnect = (async () => {
                emitStatus('connecting');

                const adapterConnected = await attachTransportAdapter() || await attachWebSocketTransport();
                if (adapterConnected) {
                    state.connected = true;
                    seedLiveCatalog();
                    emitStatus('connected', {
                        transport: transport.type || 'adapter',
                        moduleKey: state.moduleKey,
                        moduleLabel: state.moduleLabel,
                        modules: api.listModules(),
                    });

                    if (transport.autoPlay !== false) {
                        state.isPlaying = true;
                        flushBufferedTelemetry('resume');
                        emitStatus('playing', { moduleKey: state.moduleKey, moduleLabel: state.moduleLabel });
                    }
                    return getState();
                }

                const catalog = await loadCatalog();
                state.catalog = catalog.modules;
                state.transportMode = 'catalog';
                if (!state.catalog.length) {
                    throw new Error('No telemetry modules are available.');
                }

                state.connected = true;
                setModule(
                    settings.moduleKey || transport.moduleKey || catalog.defaultModule || state.catalog[0].key,
                    { emit: true, resume: false, reason: 'connect' }
                );
                emitStatus('connected', {
                    transport: transport.type || 'mock',
                    moduleKey: state.moduleKey,
                    moduleLabel: state.moduleLabel,
                    modules: api.listModules(),
                });

                if (transport.autoPlay !== false) {
                    schedulePlayback();
                    emitStatus('playing', { moduleKey: state.moduleKey, moduleLabel: state.moduleLabel });
                }

                return getState();
            })();

            try {
                return await state.pendingConnect;
            } finally {
                state.pendingConnect = null;
            }
        }

        function play() {
            if (state.destroyed) return false;
            if (!state.connected) {
                connect().catch((error) => {
                    emitStatus('error', { message: error.message });
                }).then(() => {
                    if (!state.destroyed && state.connected && !state.isPlaying) {
                        const started = schedulePlayback();
                        if (started) {
                            emitStatus('playing', { moduleKey: state.moduleKey, moduleLabel: state.moduleLabel });
                        }
                    }
                });
                return true;
            }
            if (state.transportMode === 'push') {
                state.isPlaying = true;
                flushBufferedTelemetry('resume');
                emitStatus('playing', { moduleKey: state.moduleKey, moduleLabel: state.moduleLabel });
                return true;
            }
            const module = currentModule();
            const runtime = ensureModuleRuntime(module?.key);
            if (module?.loop === false && runtime?.isTerminalFrame) {
                runtime.isTerminalFrame = false;
                runtime.lastFrameIndex = null;
                runtime.nextFrameIndex = 0;
                emitCurrentFrame('restart', { frameIndex: 0 });
            }
            const started = schedulePlayback();
            if (started) {
                emitStatus('playing', { moduleKey: state.moduleKey, moduleLabel: state.moduleLabel });
            }
            return started;
        }

        function pause() {
            stopPlayback();
            emitStatus('paused', { moduleKey: state.moduleKey, moduleLabel: state.moduleLabel });
            return true;
        }

        function destroy() {
            if (state.destroyed) return true;
            stopPlayback();
            if (state.abortController) {
                state.abortController.abort();
                state.abortController = null;
            }
            if (typeof state.cleanup === 'function') {
                try {
                    state.cleanup();
                } catch (error) {
                    console.warn('[KilnTwinController] cleanup failed', error);
                }
            }
            state.cleanup = null;
            state.connected = false;
            state.destroyed = true;
            emitStatus('destroyed');
            return true;
        }

        const api = {
            version: VERSION,
            connect,
            play,
            pause,
            setModule,
            applyTelemetry,
            destroy,
            getState,
            getSchema() {
                const provider = global.KilnTwinTelemetryMock;
                return clone(provider?.schema || {
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
                        'telemetry.ambientTemp',
                        'telemetry.humidity',
                        'telemetry.productType',
                        'telemetry.productSpec.type',
                        'telemetry.productSpec.count',
                        'telemetry.productSpec.sizeFactor',
                        'telemetry.efficiencyRatio',
                        'telemetry.pollutionDrop',
                        'telemetry.flame.blueRatio',
                        'telemetry.flame.orangeRatio',
                        'telemetry.flame.intensity',
                        'telemetry.sizeRatio',
                        'telemetry.thermal.band',
                        'telemetry.derived.temperatureBand',
                    ],
                });
            },
            listModules() {
                if (!state.catalog.length && state.moduleKey) {
                    return [{
                        key: state.moduleKey,
                        label: state.moduleLabel || state.moduleKey,
                        intervalMs: Math.max(250, Math.floor(toFiniteNumber(transport.intervalMs, 1500))),
                        description: state.transportMode === 'push' ? 'Real-time telemetry stream.' : '',
                    }];
                }
                return state.catalog.map((module) => ({
                    key: module.key,
                    label: module.label,
                    intervalMs: module.intervalMs,
                    description: module.description,
                }));
            },
        };

        return api;
    }

    global.KilnTwinController = {
        version: VERSION,
        create,
        normalizeTelemetry: normalizeTelemetryPayload,
    };
}(window));
