import * as THREE from "../three.module.min.js";

export const TEMPERATURE_RANGE = {
    min: 650,
    max: 1380,
};

const PRODUCT_SCALE_ANCHORS = Object.freeze({
    large: [
        { temp: 913, scale: 1.2 },
        { temp: 1188, scale: 1.0 },
        { temp: 1361, scale: 0.7 },
    ],
    small: [
        { temp: 913, scale: 1.12 },
        { temp: 1188, scale: 1.0 },
        { temp: 1361, scale: 0.82 },
    ],
});
const BOUNDS_NODE_BOX = new THREE.Box3();

function shouldIgnoreBoundsNode(node, root, ignoreNode) {
    let current = node;
    while (current) {
        if (current.visible === false) return true;
        if (typeof ignoreNode === "function" && ignoreNode(current)) return true;
        if (current === root) break;
        current = current.parent;
    }
    return false;
}

function isPlainObject(value) {
    return Object.prototype.toString.call(value) === "[object Object]";
}

export function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

export function lerp(start, end, alpha) {
    return start + (end - start) * alpha;
}

export function damp(current, target, lambda, delta) {
    return THREE.MathUtils.damp(current, target, lambda, delta);
}

export function toUnitInterval(value, fallback = 0) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return fallback;
    if (numeric > 1) return clamp(numeric / 100, 0, 1);
    return clamp(numeric, 0, 1);
}

export function normalizeTemperature(value, fallback = 980) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return fallback;
    return clamp(numeric, TEMPERATURE_RANGE.min, TEMPERATURE_RANGE.max);
}

export function temperatureToUnit(value) {
    return clamp(
        (normalizeTemperature(value) - TEMPERATURE_RANGE.min) / (TEMPERATURE_RANGE.max - TEMPERATURE_RANGE.min),
        0,
        1
    );
}

export function normalizeProductType(value, fallback = "small") {
    return value === "large" ? "large" : fallback === "large" ? "large" : "small";
}

export function normalizeRadiationState(value, fallback = "steady", temperature = 980) {
    const source = String(value || "").trim().toLowerCase();
    if (["enhance", "enhanced", "boost", "high", "strong", "up", "inward"].includes(source)) return "enhance";
    if (["weaken", "weakened", "low", "cool", "down", "outward"].includes(source)) return "weaken";
    if (["steady", "stable", "hold", "normal", "auto"].includes(source)) return "steady";

    const resolvedFallback = String(fallback || "").trim().toLowerCase();
    if (["enhance", "weaken", "steady"].includes(resolvedFallback)) return resolvedFallback;
    if (temperature >= 1200) return "enhance";
    if (temperature <= 1180) return "weaken";
    return "steady";
}

export function normalizeRadiationMode(value, fallback = "auto", temperature = 980) {
    const source = String(value || "").trim().toLowerCase();
    if (["inward", "enhance", "enhanced", "boost", "high", "strong"].includes(source)) return "inward";
    if (["outward", "weaken", "weakened", "low", "cool"].includes(source)) return "outward";
    if (["steady", "stable", "hold", "normal", "auto"].includes(source)) return "auto";

    const fallbackSource = String(fallback || "").trim().toLowerCase();
    if (["inward", "outward", "auto"].includes(fallbackSource)) return fallbackSource;
    if (["enhance", "enhanced"].includes(fallbackSource)) return "inward";
    if (["weaken", "weakened"].includes(fallbackSource)) return "outward";
    if (["steady", "stable"].includes(fallbackSource)) return "auto";

    return temperature >= 1200 ? "inward" : "outward";
}

function deriveFlameProfile(temperature, radiationState, radiationIntensity) {
    const heat = temperatureToUnit(temperature);
    const stateBias = radiationState === "enhance"
        ? 0.12
        : radiationState === "weaken"
            ? -0.12
            : 0;
    const orangeRatio = clamp(
        0.2 + heat * 0.58 + stateBias + (radiationIntensity - 0.5) * 0.12,
        0.08,
        0.92
    );
    const blueRatio = 1 - orangeRatio;
    const intensity = clamp(
        0.26 + heat * 0.42 + (radiationIntensity - 0.5) * 0.44,
        0.06,
        1
    );
    return {
        blueRatio,
        orangeRatio,
        intensity,
    };
}

function deriveBusinessFlameProfile(temperature, radiationState, radiationIntensity, flame) {
    const heat = temperatureToUnit(temperature);
    const flameIntensity = clamp(flame?.intensity ?? 0.5, 0.06, 1);
    const blueRatio = clamp(flame?.blueRatio ?? 0.5, 0, 1);
    const orangeRatio = clamp(flame?.orangeRatio ?? (1 - blueRatio), 0, 1);
    const stateLift = radiationState === "enhance"
        ? 0.08
        : radiationState === "weaken"
            ? -0.04
            : 0.02;

    return {
        chamberHeat: clamp(0.66 + heat * 0.22 + flameIntensity * 0.18, 0.6, 1.08),
        plumeRise: clamp(0.42 + flameIntensity * 0.42 + heat * 0.18 + stateLift, 0.24, 1.18),
        bandDrift: clamp(0.38 + blueRatio * 0.18 + radiationIntensity * 0.16, 0.24, 1.08),
        pulseSpeed: clamp(0.016 + flameIntensity * 0.032 + radiationIntensity * 0.014, 0.014, 0.07),
        shimmer: clamp(0.06 + flameIntensity * 0.12 + orangeRatio * 0.04, 0.05, 0.24),
        haze: clamp(0.16 + blueRatio * 0.08 + radiationIntensity * 0.08, 0.12, 0.32),
        burnerRadius: clamp(0.28 + flameIntensity * 0.34 + blueRatio * 0.06, 0.26, 0.72),
    };
}

function normalizeBusinessFlameProfile(input, fallback) {
    const root = isPlainObject(input) ? input : {};
    return {
        chamberHeat: clamp(readNumber(root.chamberHeat, root.chamber_heat, fallback.chamberHeat) ?? fallback.chamberHeat, 0.6, 1.08),
        plumeRise: clamp(readNumber(root.plumeRise, root.plume_rise, fallback.plumeRise) ?? fallback.plumeRise, 0.24, 1.18),
        bandDrift: clamp(readNumber(root.bandDrift, root.band_drift, fallback.bandDrift) ?? fallback.bandDrift, 0.24, 1.08),
        pulseSpeed: clamp(readNumber(root.pulseSpeed, root.pulse_speed, fallback.pulseSpeed) ?? fallback.pulseSpeed, 0.014, 0.07),
        shimmer: clamp(readNumber(root.shimmer, fallback.shimmer) ?? fallback.shimmer, 0.05, 0.24),
        haze: clamp(readNumber(root.haze, fallback.haze) ?? fallback.haze, 0.12, 0.32),
        burnerRadius: clamp(readNumber(root.burnerRadius, root.burner_radius, fallback.burnerRadius) ?? fallback.burnerRadius, 0.26, 0.72),
    };
}

export function readNumber(...candidates) {
    for (const candidate of candidates) {
        const numeric = Number(candidate);
        if (Number.isFinite(numeric)) return numeric;
    }
    return null;
}

export function mixHex(startHex, endHex, alpha) {
    const start = new THREE.Color(startHex);
    const end = new THREE.Color(endHex);
    return start.lerp(end, clamp(alpha, 0, 1));
}

export function getKilnPalette(heat) {
    const normalizedHeat = clamp(heat, 0, 1);
    const shell = mixHex(0x214866, 0x4fd5ff, 0.42 + normalizedHeat * 0.24);
    const chamber = mixHex(0x51362d, 0xd86d34, normalizedHeat);
    const glow = mixHex(0x59c9ff, 0xff9742, normalizedHeat * 0.84);
    const core = mixHex(0x9de5ff, 0xffcb84, normalizedHeat);
    const rim = mixHex(0xd5f6ff, 0xffe4b6, normalizedHeat * 0.66);
    return { shell, chamber, glow, core, rim };
}

function interpolateAnchors(temperature, anchors) {
    const clamped = normalizeTemperature(temperature, anchors[0].temp);
    for (let index = 0; index < anchors.length - 1; index += 1) {
        const start = anchors[index];
        const end = anchors[index + 1];
        if (clamped <= start.temp) return start.scale;
        if (clamped <= end.temp) {
            return THREE.MathUtils.lerp(start.scale, end.scale, (clamped - start.temp) / (end.temp - start.temp));
        }
    }
    return anchors[anchors.length - 1].scale;
}

export function computeProductScale(temperature, productType = "large", sizeFactor = 1) {
    const anchors = PRODUCT_SCALE_ANCHORS[productType === "large" ? "large" : "small"];
    const mappedScale = interpolateAnchors(temperature, anchors);
    return mappedScale * clamp(sizeFactor, 0.68, 1.4);
}

function normalizeEmissionLevel(value, fallback = 0.28) {
    if (value == null) return fallback;
    if (typeof value === "object") {
        // Prefer pollutionDrop (0-100) from controller — invert to emission level
        const drop = readNumber(
            value.pollutionDrop,
            value.pollution_drop
        );
        if (drop !== null) {
            return clamp(1 - drop / 100, 0, 1);
        }
        // Explicit level/ratio fields (already 0-1)
        const explicit = readNumber(
            value.level,
            value.intensity,
            value.ratio,
            value.smoke,
            value.opacity
        );
        if (explicit !== null) {
            return toUnitInterval(explicit, fallback);
        }
        // Derive from CO2 ppm: map 330-520 range to 0-1 emission level
        const co2 = readNumber(value.co2, value.CO2);
        if (co2 !== null && co2 > 1) {
            return clamp((co2 - 330) / (520 - 330), 0, 1);
        }
        return fallback;
    }
    return toUnitInterval(value, fallback);
}

function normalizeProductSpec(input, fallbackType) {
    const type = normalizeProductType(
        input?.type ?? input?.productType ?? input?.product_type,
        fallbackType
    );
    const countDefault = type === "large" ? 12 : 36;
    const sizeFactor = clamp(
        readNumber(input?.sizeFactor, input?.size_factor, input?.scale, input?.diameter, input?.height) ?? 1,
        0.68,
        1.45
    );
    const count = Math.round(
        clamp(
            readNumber(input?.count, input?.productCount, input?.product_count) ?? countDefault,
            4,
            type === "large" ? 24 : 48
        )
    );

    return {
        type,
        count,
        sizeFactor,
    };
}

function normalizeFlameProfile(input, fallback) {
    const root = isPlainObject(input) ? input : {};
    let blueRatio = readNumber(root.blueRatio, root.blue_ratio);
    let orangeRatio = readNumber(root.orangeRatio, root.orange_ratio);

    blueRatio = blueRatio == null ? null : toUnitInterval(blueRatio, fallback.blueRatio);
    orangeRatio = orangeRatio == null ? null : toUnitInterval(orangeRatio, fallback.orangeRatio);

    if (blueRatio !== null && orangeRatio === null) {
        orangeRatio = 1 - blueRatio;
    } else if (blueRatio === null && orangeRatio !== null) {
        blueRatio = 1 - orangeRatio;
    } else if (blueRatio !== null && orangeRatio !== null) {
        const total = blueRatio + orangeRatio;
        if (total > 0) {
            blueRatio /= total;
            orangeRatio /= total;
        } else {
            blueRatio = fallback.blueRatio;
            orangeRatio = fallback.orangeRatio;
        }
    } else {
        blueRatio = fallback.blueRatio;
        orangeRatio = fallback.orangeRatio;
    }

    return {
        blueRatio: clamp(blueRatio, 0, 1),
        orangeRatio: clamp(orangeRatio, 0, 1),
        intensity: toUnitInterval(root.intensity, fallback.intensity),
    };
}

export function normalizeTelemetry(input = {}, previous = {}) {
    const root = isPlainObject(input) ? input : {};
    const payload = isPlainObject(root.telemetry) ? root.telemetry : root;
    const thermal = isPlainObject(payload.thermal) ? payload.thermal : {};
    const radiation = isPlainObject(payload.radiation)
        ? payload.radiation
        : isPlainObject(thermal.radiation)
            ? thermal.radiation
            : {};
    const product = isPlainObject(payload.product) ? payload.product : {};
    const flameRoot = isPlainObject(payload.flame)
        ? payload.flame
        : isPlainObject(root.flame)
            ? root.flame
            : {};

    const previousProductType = previous.productType || "small";
    const productSpec = normalizeProductSpec(
        payload.productSpec ||
            payload.product_spec ||
            root.productSpec ||
            root.product_spec ||
            product.spec ||
            payload.spec ||
            root.spec,
        previousProductType
    );

    const temperature = normalizeTemperature(
        readNumber(
            payload.temperature,
            payload.temp,
            root.temperature,
            root.temp,
            thermal.temperature,
            thermal.temp,
            payload.chamberTemperature,
            payload.chamber_temperature,
            previous.temperature
        ),
        previous.temperature || 980
    );

    const productType = normalizeProductType(
        payload.productType ??
            payload.product_type ??
            root.productType ??
            root.product_type ??
            product.type ??
            product.productType ??
            productSpec.type ??
            previous.productType,
        previousProductType
    );

    const productCount = Math.round(
        clamp(
            readNumber(
                payload.productCount,
                payload.product_count,
                root.productCount,
                root.product_count,
                product.count,
                product.productCount,
                productSpec.count,
                previous.productCount
            ) ?? (productType === "large" ? 12 : 36),
            1,
            productType === "large" ? 24 : 48
        )
    );

    const radiationState = normalizeRadiationState(
        payload.radiationState ??
            payload.radiation_state ??
            payload.radiation ??
            root.radiationState ??
            root.radiation_state ??
            root.radiation ??
            thermal.radiationState ??
            thermal.radiation_state ??
            radiation.state ??
            previous.radiationState,
        previous.radiationState || "steady",
        temperature
    );

    const efficiency = toUnitInterval(
        readNumber(
            payload.efficiency,
            payload.efficiencyRatio,
            payload.efficiency_ratio,
            payload.kilnEfficiency,
            payload.kiln_efficiency,
            root.efficiency,
            thermal.efficiency,
            previous.efficiency
        ),
        previous.efficiency ?? 0.78
    );

    const emissionLevel = normalizeEmissionLevel(
        payload.emissions ??
            payload.emission ??
            root.emissions ??
            root.emission ??
            payload.environment?.emissions ??
            previous.emissionLevel,
        previous.emissionLevel ?? 0.28
    );

    const radiationIntensity = toUnitInterval(
        readNumber(
            payload.radiationIntensity,
            payload.radiation_intensity,
            payload.radiationOpacity,
            payload.radiation_opacity,
            root.radiationIntensity,
            root.radiation_intensity,
            radiation.intensity,
            radiation.opacity,
            previous.radiationIntensity
        ),
        previous.radiationIntensity ?? 0.72
    );

    const radiationMode = normalizeRadiationMode(
        payload.radiationMode ??
            payload.radiation_mode ??
            root.radiationMode ??
            root.radiation_mode ??
            thermal.radiationMode ??
            thermal.radiation_mode ??
            radiation.mode ??
            previous.radiationMode,
        previous.radiationMode || radiationState,
        temperature
    );

    const flame = normalizeFlameProfile(
        flameRoot,
        deriveFlameProfile(temperature, radiationState, radiationIntensity)
    );
    const flameProfileRoot = payload.flameProfile
        ?? payload.flame_profile
        ?? root.flameProfile
        ?? root.flame_profile
        ?? previous.flameProfile
        ?? previous.flame_profile;
    const flameProfile = normalizeBusinessFlameProfile(
        flameProfileRoot,
        deriveBusinessFlameProfile(temperature, radiationState, radiationIntensity, flame)
    );

    return {
        temperature,
        heat: temperatureToUnit(temperature),
        productType,
        productCount,
        productLayoutKey: `${productType}-${productCount}`,
        productSpec: {
            ...productSpec,
            type: productType,
            count: productCount,
        },
        radiationState,
        radiationMode,
        radiationIntensity,
        efficiency,
        emissionLevel,
        flame,
        flameProfile,
        ambientTemp: readNumber(
            payload.ambientTemp,
            payload.ambient_temp,
            root.ambientTemp,
            root.ambient_temp,
            payload.environment?.ambientTemp,
            payload.environment?.ambient_temp,
            previous.ambientTemp
        ),
        humidity: readNumber(
            payload.humidity,
            root.humidity,
            payload.environment?.humidity,
            previous.humidity
        ),
        palette: getKilnPalette(temperatureToUnit(temperature)),
    };
}

export function disposeMaterial(material, seen = new Set()) {
    if (!material) return;
    const materials = Array.isArray(material) ? material : [material];
    for (const item of materials) {
        if (!item || seen.has(item)) continue;
        seen.add(item);
        for (const value of Object.values(item)) {
            if (value && typeof value === "object" && typeof value.dispose === "function" && value !== item) {
                value.dispose();
            }
        }
        item.dispose?.();
    }
}

export function disposeObject3D(root) {
    if (!root) return;
    const seenGeometries = new Set();
    const seenMaterials = new Set();
    root.traverse((node) => {
        if (node.geometry && !seenGeometries.has(node.geometry)) {
            seenGeometries.add(node.geometry);
            node.geometry.dispose?.();
        }
        disposeMaterial(node.material, seenMaterials);
    });
}

export function measureObjectBounds(root, target = new THREE.Box3(), options = {}) {
    target.makeEmpty();
    if (!root) return target;
    root.updateWorldMatrix?.(true, true);
    const ignoreNode = options?.ignoreNode;
    root.traverse((node) => {
        if (!node.geometry || shouldIgnoreBoundsNode(node, root, ignoreNode)) return;
        if (!node.geometry.boundingBox) {
            node.geometry.computeBoundingBox?.();
        }
        if (!node.geometry.boundingBox) return;
        BOUNDS_NODE_BOX.copy(node.geometry.boundingBox).applyMatrix4(node.matrixWorld);
        target.union(BOUNDS_NODE_BOX);
    });
    return target;
}
