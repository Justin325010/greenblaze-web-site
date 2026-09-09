import * as THREE from "../three.module.min.js";
import {
    clamp,
    computeProductScale,
    disposeMaterial,
    getKilnPalette,
    temperatureToUnit,
} from "./kiln-scene-helpers.js";

const UP = new THREE.Vector3(0, 1, 0);
const TEMP_DIRECTION = new THREE.Vector3();
const TEMP_TARGET = new THREE.Vector3();
const TEMP_SCALE = new THREE.Vector3();
const TEMP_QUATERNION = new THREE.Quaternion();
const TEMP_COLOR = new THREE.Color();
const TEMP_RADIAL = new THREE.Vector3();
const TEMP_TANGENT = new THREE.Vector3();
const TEMP_AXIAL = new THREE.Vector3();
const COOL_FLAME = new THREE.Color(0x2b8cff);
const COOL_RIM = new THREE.Color(0x86d9ff);
const WARM_CORE = new THREE.Color(0xff9a48);
const HOT_CORE = new THREE.Color(0xffd17a);
const STEADY_GLOW = new THREE.Color(0xffe0a6);

/* ── Smoke palette ── */
const SMOKE_COOL = new THREE.Color(0x8899aa);
const SMOKE_WARM = new THREE.Color(0x665544);
const SMOKE_HOT = new THREE.Color(0x443322);

function smoothValue(current, target, delta, lambda = 5.2) {
    return THREE.MathUtils.damp(current, target, lambda, delta);
}

function resolveDelta(nextTime, previousTime, fallback = 1 / 60) {
    if (!Number.isFinite(nextTime)) return fallback;
    if (!Number.isFinite(previousTime)) return fallback;
    return clamp(nextTime - previousTime, 1 / 120, 0.05);
}

function readTemperature(state = {}) {
    const numeric = Number(state.temperature ?? state.temp);
    return Number.isFinite(numeric) ? numeric : 980;
}

function readRadiationState(state = {}) {
    const explicit = state.radiationState ?? state.radiation_state ?? state.radiation?.state;
    if (explicit === "enhance" || explicit === "steady" || explicit === "weaken") return explicit;
    if (state.radiationMode === "inward") return "enhance";
    if (state.radiationMode === "outward") return "weaken";
    return null;
}

function resolveEffectProfile(state = {}) {
    const temperature = readTemperature(state);
    const heat = temperatureToUnit(temperature);
    const intensity = clamp(state.radiationIntensity ?? 0.72, 0.08, 1);
    const efficiency = clamp(state.efficiency ?? 0.78, 0.2, 1);
    const emissionLevel = clamp(state.emissionLevel ?? 0.28, 0, 1);
    const explicitState = readRadiationState(state);

    let key = explicitState;
    if (temperature >= 1225) {
        key = "enhance";
    } else if (temperature < 1225) {
        key = "weaken";
    } else if (!key) {
        key = "steady";
    }

    const thermalBias = THREE.MathUtils.smoothstep(temperature, 1130, 1270) * 2 - 1;
    const radialBias = key === "enhance" ? 1 : key === "weaken" ? -1 : thermalBias * 0.35;
    const focus = key === "enhance" ? 0.92 : key === "weaken" ? 0.22 : 0.54;
    const expansion = key === "weaken" ? 0.92 : key === "steady" ? 0.42 : 0.14;
    const swirl = key === "enhance" ? 0.58 : key === "steady" ? 0.78 : 1.02;
    const warmth = clamp(heat * 0.62 + (key === "enhance" ? 0.34 : key === "weaken" ? -0.16 : 0.04), 0, 1);
    const density = clamp(
        0.56 + heat * 0.18 + intensity * 0.16 + efficiency * 0.08 +
            (key === "enhance" ? 0.18 : key === "weaken" ? -0.12 : 0),
        0.34, 1
    );
    const flameHeight = clamp(
        0.76 + heat * 0.2 + intensity * 0.08 +
            (key === "enhance" ? 0.18 : key === "weaken" ? -0.12 : 0),
        0.58, 1.18
    );
    const brightness = clamp(
        0.54 + heat * 0.28 + intensity * 0.2 + efficiency * 0.1 -
            emissionLevel * 0.06 +
            (key === "enhance" ? 0.18 : key === "weaken" ? -0.08 : 0),
        0.42, 1.22
    );
    const coreVisibility = clamp(
        (key === "enhance" ? 0.55 : key === "steady" ? 0.22 : 0.08) + warmth * 0.38,
        0.08, 1
    );
    const spread = clamp(0.28 + expansion * 0.52 - focus * 0.08, 0.18, 0.88);
    const arrowLength = clamp(
        0.58 + intensity * 0.22 +
            (key === "enhance" ? 0.26 : key === "weaken" ? 0.14 : 0.18),
        0.46, 1.08
    );
    const axialFlow = key === "enhance" ? 0.22 : key === "steady" ? 0.16 : 0.28;

    return {
        key, heat, intensity, efficiency, emissionLevel,
        radialBias, focus, expansion, swirl, warmth, density,
        flameHeight, brightness, coreVisibility, spread, arrowLength, axialFlow,
    };
}

/* ── Radiation color ── */
function createRadiationColor(profile, palette) {
    if (profile.radialBias > 0.25) {
        return TEMP_COLOR.copy(COOL_RIM).lerp(palette.glow, 0.28)
            .lerp(WARM_CORE, profile.warmth * 0.52)
            .lerp(HOT_CORE, profile.focus * 0.18);
    }
    if (profile.radialBias < -0.25) {
        return TEMP_COLOR.copy(COOL_FLAME).lerp(COOL_RIM, 0.38)
            .lerp(palette.core, profile.heat * 0.14);
    }
    return TEMP_COLOR.copy(COOL_RIM).lerp(palette.core, 0.34)
        .lerp(STEADY_GLOW, profile.warmth * 0.16);
}

/* ═══════════════════════════════════════════════════════════════
   Radiation Field — enhanced directional patterns per state
   ═══════════════════════════════════════════════════════════════ */
export function createRadiationField(options = {}) {
    const count = options.count ?? 54;
    const chamberRadius = options.chamberRadius ?? 36;
    const chamberLength = options.chamberLength ?? 160;
    const group = new THREE.Group();
    group.name = "kiln-radiation-field";

    const geometry = new THREE.ConeGeometry(1.2, 7.4, 10, 1);
    geometry.translate(0, 3.7, 0);

    const material = new THREE.MeshBasicMaterial({
        color: 0x67bcff,
        transparent: true,
        opacity: 0.88,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        toneMapped: false,
    });

    const mesh = new THREE.InstancedMesh(geometry, material, count);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    group.add(mesh);

    const instances = Array.from({ length: count }, (_, index) => {
        const t = index / count;
        const angle = t * Math.PI * 2;
        const axialBand = (index % 9) / 8;
        return {
            axial: THREE.MathUtils.lerp(-chamberLength * 0.44, chamberLength * 0.44, axialBand),
            radius: chamberRadius + 4 + (index % 3) * 1.25,
            angle,
            phase: Math.random() * Math.PI * 2,
            lengthBias: 0.82 + Math.random() * 0.34,
        };
    });

    const dummy = new THREE.Object3D();
    const motion = {
        radialBias: 0, focus: 0.52, expansion: 0.36, swirl: 0.8,
        warmth: 0.45, brightness: 0.66, arrowLength: 0.72, axialFlow: 0.2, opacity: 0.62,
    };
    let lastTime = Number.isFinite(options.initialState?.time) ? options.initialState.time : null;

    function update(state = {}) {
        const profile = resolveEffectProfile(state);
        const palette = state.palette || getKilnPalette(profile.heat);
        const time = Number.isFinite(state.time) ? state.time : 0;
        const delta = resolveDelta(time, lastTime);
        lastTime = time;

        motion.radialBias = smoothValue(motion.radialBias, profile.radialBias, delta, 5.6);
        motion.focus = smoothValue(motion.focus, profile.focus, delta, 5.2);
        motion.expansion = smoothValue(motion.expansion, profile.expansion, delta, 5);
        motion.swirl = smoothValue(motion.swirl, profile.swirl, delta, 4.8);
        motion.warmth = smoothValue(motion.warmth, profile.warmth, delta, 4.8);
        motion.brightness = smoothValue(motion.brightness, profile.brightness, delta, 5.1);
        motion.arrowLength = smoothValue(motion.arrowLength, profile.arrowLength, delta, 5.4);
        motion.axialFlow = smoothValue(motion.axialFlow, profile.axialFlow, delta, 5.2);
        motion.opacity = smoothValue(
            motion.opacity,
            clamp(0.28 + profile.intensity * 0.32 + profile.brightness * 0.24, 0.26, 0.94),
            delta, 5
        );

        material.opacity = 0.18 + motion.opacity * 0.76;

        /* Enhanced: converge bias for enhance, diverge for weaken, balanced orbit for steady */
        const convergeFactor = clamp(motion.radialBias, -1, 1);
        const focusTight = motion.focus * 0.85 + 0.15;

        for (let index = 0; index < instances.length; index += 1) {
            const item = instances[index];
            const angle = item.angle + time * (0.18 + motion.swirl * 0.18) + item.phase * 0.18;
            const radialPulse = Math.sin(time * (1.4 + motion.swirl * 0.55) + item.phase)
                * (0.9 + motion.expansion * 1.4);

            /* Enhanced orbit: enhance shrinks radius (converge), weaken expands (diverge) */
            const convergeShrink = convergeFactor > 0 ? convergeFactor * 0.18 * focusTight : 0;
            const divergeGrow = convergeFactor < 0 ? -convergeFactor * 0.22 : 0;
            const orbitRadius = item.radius
                * (1.02 + motion.expansion * 0.12 - convergeShrink + divergeGrow - motion.focus * 0.08)
                + radialPulse;

            const axialWave = Math.sin(time * (0.92 + motion.swirl * 0.18) + item.phase)
                * (1.2 + motion.axialFlow * 4.4);
            const x = item.axial + axialWave * item.lengthBias;
            const y = Math.cos(angle) * orbitRadius;
            const z = Math.sin(angle) * orbitRadius;

            TEMP_RADIAL.set(0, -y, -z);
            if (TEMP_RADIAL.lengthSq() < 1e-6) {
                TEMP_RADIAL.set(0, -1, 0);
            } else {
                TEMP_RADIAL.normalize();
            }
            TEMP_TANGENT.set(0, -Math.sin(angle), Math.cos(angle)).normalize();
            TEMP_AXIAL.set(Math.sin(time * 0.68 + item.phase), 0, 0);

            /* Enhanced direction: enhance points strongly inward, weaken strongly outward,
               steady balanced tangential orbit */
            const inwardStrength = convergeFactor > 0
                ? convergeFactor * (0.78 + focusTight * 0.42)
                : convergeFactor * (0.48 + motion.expansion * 0.32);
            const tangentStrength = 0.28 + motion.swirl * 0.52
                + (Math.abs(convergeFactor) < 0.3 ? 0.22 : 0);

            TEMP_DIRECTION.copy(TEMP_RADIAL).multiplyScalar(inwardStrength);
            TEMP_DIRECTION.addScaledVector(TEMP_TANGENT, tangentStrength);
            TEMP_DIRECTION.addScaledVector(TEMP_AXIAL, 0.12 + motion.axialFlow * 0.34);
            if (TEMP_DIRECTION.lengthSq() < 1e-6) {
                TEMP_TARGET.set(x, 0, 0);
                TEMP_DIRECTION.set(TEMP_TARGET.x - x, TEMP_TARGET.y - y, TEMP_TARGET.z - z).normalize();
            } else {
                TEMP_DIRECTION.normalize();
            }

            TEMP_QUATERNION.setFromUnitVectors(UP, TEMP_DIRECTION);

            const pulse = 0.86 + Math.sin(time * 3.2 + item.phase) * 0.12
                + Math.cos(time * 1.6 + item.phase) * 0.04;
            const length = (4.8 + profile.heat * 4.6 + motion.arrowLength * 7.2)
                * item.lengthBias * pulse;
            const width = 0.62 + motion.opacity * 0.22 + profile.heat * 0.14;
            TEMP_SCALE.set(width, length, width);

            dummy.position.set(x, y, z);
            dummy.quaternion.copy(TEMP_QUATERNION);
            dummy.scale.copy(TEMP_SCALE);
            dummy.updateMatrix();
            mesh.setMatrixAt(index, dummy.matrix);

            createRadiationColor(
                { radialBias: motion.radialBias, warmth: motion.warmth, focus: motion.focus, heat: profile.heat },
                palette
            ).multiplyScalar(0.82 + motion.brightness * 0.28);
            mesh.setColorAt(index, TEMP_COLOR);
        }

        group.userData.radiationState = profile.key;
        group.userData.radiationDirection = motion.radialBias >= 0 ? "inward" : "outward";
        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }

    function dispose() {
        geometry.dispose();
        disposeMaterial(material);
    }

    update(options.initialState);

    return { group, update, dispose };
}

/* ═══════════════════════════════════════════════════════════════
   Flame System — enhanced warm/cool + 3-state differentiation
   ═══════════════════════════════════════════════════════════════ */

function resetFlameParticle(index, meta, positions, baseWidth, baseHeight, isCore) {
    const side = index % 2 === 0 ? -1 : 1;
    const stream = Math.floor(index / 2) % 5;
    meta[index] = meta[index] || {};
    meta[index].life = Math.random();
    meta[index].phase = Math.random() * Math.PI * 2;
    meta[index].drift = (Math.random() - 0.5) * 0.65;
    meta[index].rise = (isCore ? 22 : 26) + Math.random() * (isCore ? 10 : 18);
    meta[index].side = side;
    meta[index].stream = stream;
    positions[index * 3] = side * (baseWidth * 0.18 + Math.random() * baseWidth * 0.18);
    positions[index * 3 + 1] = -baseHeight * 0.46 + Math.random() * 8;
    positions[index * 3 + 2] = (stream - 2) * 8 + (Math.random() - 0.5) * 5;
}

function createFlamePoints(count, size) {
    const geometry = new THREE.BufferGeometry();
    const positions = new Float32Array(count * 3);
    const colors = new Float32Array(count * 3);
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));

    const material = new THREE.PointsMaterial({
        size,
        transparent: true,
        opacity: 0.72,
        vertexColors: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        sizeAttenuation: true,
        toneMapped: false,
    });

    return { geometry, material, points: new THREE.Points(geometry, material), positions, colors };
}

/* Enhanced flame tinting: stronger warm/cool separation per state */
function tintFlameParticle(isCore, motion, palette, lifeRatio) {
    const ageFade = clamp(lifeRatio, 0, 1);
    if (isCore) {
        /* Core: enhance → hot gold/orange, weaken → cool blue, steady → warm amber */
        TEMP_COLOR.copy(COOL_FLAME)
            .lerp(palette.core, 0.34 + motion.heat * 0.18)
            .lerp(WARM_CORE, motion.warmth * 0.82)
            .lerp(HOT_CORE, motion.coreVisibility * 0.42);
        /* Enhance pushes brighter, weaken pushes bluer */
        if (motion.radialBias > 0.2) {
            TEMP_COLOR.lerp(HOT_CORE, motion.radialBias * 0.28);
        } else if (motion.radialBias < -0.2) {
            TEMP_COLOR.lerp(COOL_FLAME, -motion.radialBias * 0.32);
        }
        /* Tip particles fade cooler */
        TEMP_COLOR.lerp(COOL_RIM, (1 - ageFade) * 0.18);
        return TEMP_COLOR;
    }
    /* Outer shell: wider color range */
    TEMP_COLOR.copy(COOL_FLAME)
        .lerp(COOL_RIM, 0.32)
        .lerp(palette.rim, motion.heat * 0.18 + motion.warmth * 0.08)
        .lerp(WARM_CORE, Math.max(0, motion.radialBias) * 0.24);
    if (motion.radialBias < -0.2) {
        TEMP_COLOR.lerp(COOL_FLAME, -motion.radialBias * 0.26);
    }
    TEMP_COLOR.lerp(COOL_RIM, (1 - ageFade) * 0.12);
    return TEMP_COLOR;
}

export function createFlameSystem(options = {}) {
    const chamberRadius = options.chamberRadius ?? 36;
    const chamberHeight = options.chamberHeight ?? 84;
    const group = new THREE.Group();
    group.name = "kiln-flame-system";

    const shell = createFlamePoints(options.outerCount ?? 320, 8.4);
    const core = createFlamePoints(options.coreCount ?? 180, 5.2);
    const heatGeometry = new THREE.SphereGeometry(1, 24, 18);
    const heatEnvelopeMaterial = new THREE.MeshBasicMaterial({
        color: 0x66c7ff, transparent: true, opacity: 0.14,
        depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false,
    });
    const heatCoreMaterial = new THREE.MeshBasicMaterial({
        color: 0x4fb6ff, transparent: true, opacity: 0.12,
        depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false,
    });
    const heatEnvelope = new THREE.Mesh(heatGeometry, heatEnvelopeMaterial);
    const heatCore = new THREE.Mesh(heatGeometry, heatCoreMaterial);
    const outerMeta = Array.from({ length: shell.positions.length / 3 }, () => ({}));
    const coreMeta = Array.from({ length: core.positions.length / 3 }, () => ({}));

    group.add(heatEnvelope, heatCore, shell.points, core.points);

    for (let i = 0; i < outerMeta.length; i++) {
        resetFlameParticle(i, outerMeta, shell.positions, chamberRadius, chamberHeight, false);
    }
    for (let i = 0; i < coreMeta.length; i++) {
        resetFlameParticle(i, coreMeta, core.positions, chamberRadius * 0.8, chamberHeight, true);
    }

    const motion = {
        radialBias: 0, height: 0.86, density: 0.72, brightness: 0.72,
        warmth: 0.38, spread: 0.34, coreVisibility: 0.24, focus: 0.52,
        heat: 0.48, emissionLevel: 0.28,
    };
    let lastTime = null;

    function stepLayer(layer, meta, palette, time, delta, isCore) {
        const turbulence = 0.36 + motion.spread * 0.72 + motion.emissionLevel * 0.32;
        const energy = 0.74 + motion.brightness * 0.38 + motion.heat * 0.26;

        /* Enhanced: enhance → tighter/taller, weaken → wider/shorter, steady → balanced */
        const stateSpreadMod = motion.radialBias > 0.2 ? -0.08 : motion.radialBias < -0.2 ? 0.12 : 0;
        const stateHeightMod = motion.radialBias > 0.2 ? 0.15 : motion.radialBias < -0.2 ? -0.1 : 0;

        const activeCount = Math.max(
            isCore ? 18 : 28,
            Math.round(meta.length * clamp(
                isCore
                    ? motion.density * (0.48 + motion.coreVisibility * 0.42)
                    : motion.density * (0.72 + motion.brightness * 0.16),
                isCore ? 0.12 : 0.22, 1
            ))
        );
        const particleBaseWidth = (isCore ? chamberRadius * 0.72 : chamberRadius)
            * (1 + (motion.spread + stateSpreadMod) * (isCore ? 0.08 : 0.14));
        const heightLimit = chamberHeight
            * ((isCore ? 0.18 : 0.24) + (motion.height + stateHeightMod) * (isCore ? 0.38 : 0.46));
        const horizontalLimit = particleBaseWidth * (isCore ? 0.22 : 0.28);
        const depthLimit = (isCore ? 9 : 12) + motion.spread * 12;

        layer.geometry.setDrawRange(0, activeCount);

        for (let index = 0; index < meta.length; index++) {
            const item = meta[index];
            const i3 = index * 3;
            item.life -= delta * (0.58 + energy * 0.22 + (1 - motion.density) * 0.12);

            const swirl = Math.sin(time * (2.1 + item.stream * 0.14) + item.phase) * turbulence;
            const radialDrift = item.side * (-0.18 * motion.radialBias);
            const drift = item.drift * (0.04 + motion.spread * 0.05);
            layer.positions[i3] += (radialDrift + drift + swirl * 0.035) * energy;
            layer.positions[i3 + 1] += item.rise * delta
                * (0.62 + (motion.height + stateHeightMod) * 0.5 + (isCore ? motion.coreVisibility * 0.12 : 0));
            layer.positions[i3 + 2] += Math.cos(time * 1.6 + item.phase) * 0.12 * (0.8 + motion.spread * 0.6);

            if (item.life <= 0 || layer.positions[i3 + 1] > heightLimit) {
                resetFlameParticle(index, meta, layer.positions,
                    particleBaseWidth, chamberHeight * (0.9 + motion.height * 0.12), isCore);
            } else {
                layer.positions[i3] = clamp(layer.positions[i3], -horizontalLimit, horizontalLimit);
                layer.positions[i3 + 2] = clamp(layer.positions[i3 + 2], -depthLimit, depthLimit);
            }

            tintFlameParticle(isCore, motion, palette, item.life);
            layer.colors[i3] = TEMP_COLOR.r;
            layer.colors[i3 + 1] = TEMP_COLOR.g;
            layer.colors[i3 + 2] = TEMP_COLOR.b;
        }

        layer.geometry.attributes.position.needsUpdate = true;
        layer.geometry.attributes.color.needsUpdate = true;
        layer.material.opacity = isCore
            ? clamp(0.08 + motion.coreVisibility * 0.72, 0.08, 0.92)
            : clamp(0.32 + motion.brightness * 0.34 + motion.heat * 0.1, 0.28, 0.86);
        layer.material.size = (isCore ? 3.8 : 6.8) + motion.heat * (isCore ? 1.8 : 2.4)
            + motion.density * (isCore ? 1.4 : 1.8);
    }

    function update(state = {}, delta = 1 / 60) {
        const profile = resolveEffectProfile(state);
        const palette = state.palette || getKilnPalette(profile.heat);
        const time = Number.isFinite(state.time) ? state.time : 0;
        const derivedDelta = Number.isFinite(state.time) ? resolveDelta(time, lastTime, delta) : delta;
        lastTime = time;

        motion.radialBias = smoothValue(motion.radialBias, profile.radialBias, derivedDelta, 5.2);
        motion.height = smoothValue(motion.height, profile.flameHeight, derivedDelta, 5.4);
        motion.density = smoothValue(motion.density, profile.density, derivedDelta, 4.8);
        motion.brightness = smoothValue(motion.brightness, profile.brightness, derivedDelta, 5.1);
        motion.warmth = smoothValue(motion.warmth, profile.warmth, derivedDelta, 4.8);
        motion.spread = smoothValue(motion.spread, profile.spread, derivedDelta, 4.9);
        motion.coreVisibility = smoothValue(motion.coreVisibility, profile.coreVisibility, derivedDelta, 5.2);
        motion.focus = smoothValue(motion.focus, profile.focus, derivedDelta, 5.2);
        motion.heat = smoothValue(motion.heat, profile.heat, derivedDelta, 5.4);
        motion.emissionLevel = smoothValue(motion.emissionLevel, profile.emissionLevel, derivedDelta, 4.6);

        stepLayer(shell, outerMeta, palette, time, derivedDelta, false);
        stepLayer(core, coreMeta, palette, time, derivedDelta, true);

        const thermalScale = computeProductScale(state.temperature, "large", 0.58);
        group.scale.set(1 + motion.spread * 0.05, 0.78 + motion.height * 0.48, 1 + motion.spread * 0.08);
        group.position.y = -8 + motion.height * 7;
        group.rotation.z = Math.sin(time * 0.42) * 0.02 * (0.6 + motion.spread * 0.6);

        shell.points.position.x = Math.sin(time * 0.8) * (1.4 + motion.spread * 1.6) - motion.radialBias * 0.8;
        core.points.position.x = -Math.sin(time * 1.1) * (0.6 + motion.spread * 0.8) - motion.radialBias * 0.35;
        shell.points.scale.setScalar(thermalScale * (0.15 + motion.brightness * 0.08));
        core.points.scale.setScalar(thermalScale * (0.12 + motion.coreVisibility * 0.05));

        heatEnvelope.position.y = -2 + motion.height * 10;
        heatEnvelope.rotation.y = time * (0.18 + motion.spread * 0.12);
        heatEnvelope.scale.set(
            chamberRadius * (0.54 + motion.spread * 0.28),
            chamberHeight * (0.22 + motion.height * 0.18),
            chamberRadius * (0.46 + motion.spread * 0.24)
        );
        /* Enhanced: envelope color shifts more dramatically per state */
        heatEnvelope.material.color.copy(COOL_RIM).lerp(palette.glow, 0.38 + motion.warmth * 0.4);
        if (motion.radialBias > 0.2) {
            heatEnvelope.material.color.lerp(WARM_CORE, motion.radialBias * 0.22);
        } else if (motion.radialBias < -0.2) {
            heatEnvelope.material.color.lerp(COOL_FLAME, -motion.radialBias * 0.18);
        }
        heatEnvelope.material.opacity = clamp(0.06 + motion.brightness * 0.12 + motion.spread * 0.06, 0.04, 0.28);

        heatCore.position.y = -4 + motion.height * 8;
        heatCore.rotation.z = -time * (0.22 + motion.focus * 0.08);
        heatCore.scale.set(
            chamberRadius * (0.26 + motion.focus * 0.22),
            chamberHeight * (0.14 + motion.height * 0.12),
            chamberRadius * (0.22 + motion.focus * 0.18)
        );
        heatCore.material.color.copy(COOL_FLAME).lerp(WARM_CORE, motion.warmth * 0.82)
            .lerp(HOT_CORE, motion.coreVisibility * 0.16);
        heatCore.material.opacity = clamp(0.05 + motion.coreVisibility * 0.22, 0.04, 0.34);

        group.userData.flameState = profile.key;
    }

    function dispose() {
        shell.geometry.dispose();
        core.geometry.dispose();
        heatGeometry.dispose();
        disposeMaterial(shell.material);
        disposeMaterial(core.material);
        disposeMaterial(heatEnvelopeMaterial);
        disposeMaterial(heatCoreMaterial);
    }

    return { group, update, dispose };
}

/* ═══════════════════════════════════════════════════════════════
   Smoke System — chimney smoke linked to emissionLevel / heat
   ═══════════════════════════════════════════════════════════════
   Mount point: attach group to contentRoot at the chimney top.
   Position hint: (0, chimneyY + 36, -10) where chimneyY = 92.
   ═══════════════════════════════════════════════════════════════ */

function resetSmokeParticle(index, meta, positions, baseRadius) {
    const angle = Math.random() * Math.PI * 2;
    const r = Math.random() * baseRadius * 0.6;
    meta[index] = meta[index] || {};
    meta[index].life = 0.7 + Math.random() * 0.3;
    meta[index].phase = Math.random() * Math.PI * 2;
    meta[index].drift = (Math.random() - 0.5) * 0.4;
    meta[index].riseSpeed = 8 + Math.random() * 12;
    meta[index].sway = (Math.random() - 0.5) * 0.6;
    positions[index * 3] = Math.cos(angle) * r;
    positions[index * 3 + 1] = 0;
    positions[index * 3 + 2] = Math.sin(angle) * r;
}

export function createSmokeSystem(options = {}) {
    const particleCount = options.count ?? 120;
    const baseRadius = options.baseRadius ?? 9;
    const maxHeight = options.maxHeight ?? 80;
    const group = new THREE.Group();
    group.name = "kiln-smoke-system";

    const geometry = new THREE.BufferGeometry();
    const positions = new Float32Array(particleCount * 3);
    const colors = new Float32Array(particleCount * 3);
    const sizes = new Float32Array(particleCount);
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    geometry.setAttribute("size", new THREE.BufferAttribute(sizes, 1));

    const material = new THREE.PointsMaterial({
        size: 6,
        transparent: true,
        opacity: 0.32,
        vertexColors: true,
        depthWrite: false,
        blending: THREE.NormalBlending,
        sizeAttenuation: true,
        toneMapped: false,
    });

    const points = new THREE.Points(geometry, material);
    group.add(points);

    const meta = Array.from({ length: particleCount }, () => ({}));
    for (let i = 0; i < particleCount; i++) {
        resetSmokeParticle(i, meta, positions, baseRadius);
    }

    const motion = {
        density: 0.3,
        riseSpeed: 0.4,
        opacity: 0.25,
        warmth: 0.3,
        spread: 0.3,
        emissionLevel: 0.28,
        heat: 0.48,
    };
    let lastTime = null;

    function update(state = {}, delta = 1 / 60) {
        const profile = resolveEffectProfile(state);
        const time = Number.isFinite(state.time) ? state.time : 0;
        const derivedDelta = Number.isFinite(state.time) ? resolveDelta(time, lastTime, delta) : delta;
        lastTime = time;

        /* Smooth interpolation of smoke parameters */
        const targetDensity = clamp(0.15 + profile.emissionLevel * 0.65 + profile.heat * 0.2, 0.1, 1);
        const targetRise = clamp(0.2 + profile.emissionLevel * 0.5 + profile.heat * 0.3, 0.15, 1);
        const targetOpacity = clamp(0.08 + profile.emissionLevel * 0.52 + profile.heat * 0.12, 0.06, 0.62);
        const targetWarmth = profile.warmth;
        const targetSpread = clamp(0.2 + profile.emissionLevel * 0.4 + profile.expansion * 0.2, 0.15, 0.85);

        motion.density = smoothValue(motion.density, targetDensity, derivedDelta, 4.2);
        motion.riseSpeed = smoothValue(motion.riseSpeed, targetRise, derivedDelta, 4.5);
        motion.opacity = smoothValue(motion.opacity, targetOpacity, derivedDelta, 4.0);
        motion.warmth = smoothValue(motion.warmth, targetWarmth, derivedDelta, 4.8);
        motion.spread = smoothValue(motion.spread, targetSpread, derivedDelta, 4.4);
        motion.emissionLevel = smoothValue(motion.emissionLevel, profile.emissionLevel, derivedDelta, 4.6);
        motion.heat = smoothValue(motion.heat, profile.heat, derivedDelta, 5.0);

        const activeCount = Math.max(8, Math.round(particleCount * clamp(motion.density, 0.08, 1)));
        geometry.setDrawRange(0, activeCount);

        material.opacity = clamp(motion.opacity, 0.04, 0.58);

        for (let index = 0; index < meta.length; index++) {
            const item = meta[index];
            const i3 = index * 3;

            item.life -= derivedDelta * (0.3 + motion.riseSpeed * 0.35);

            /* Rise with turbulence */
            const riseRate = item.riseSpeed * motion.riseSpeed;
            const sway = Math.sin(time * (1.2 + item.phase * 0.3) + item.phase) * motion.spread * 2.5;
            const drift = item.drift * (1 + motion.spread * 0.8);

            positions[i3] += (drift + sway * 0.06) * (0.6 + motion.emissionLevel * 0.4);
            positions[i3 + 1] += riseRate * derivedDelta;
            positions[i3 + 2] += item.sway * 0.04 * (0.5 + motion.spread * 0.5);

            /* Expand as smoke rises */
            const heightRatio = clamp(positions[i3 + 1] / maxHeight, 0, 1);
            positions[i3] += Math.sin(time * 0.8 + item.phase) * heightRatio * 0.15;

            if (item.life <= 0 || positions[i3 + 1] > maxHeight * (0.6 + motion.density * 0.4)) {
                resetSmokeParticle(index, meta, positions, baseRadius * (1 + motion.spread * 0.3));
            }

            /* Color: cool gray → warm brown/dark based on heat and emission */
            const ageFade = clamp(item.life, 0, 1);
            TEMP_COLOR.copy(SMOKE_COOL)
                .lerp(SMOKE_WARM, motion.warmth * 0.65)
                .lerp(SMOKE_HOT, motion.heat * 0.35);
            /* Fade to lighter gray as particles rise and age */
            TEMP_COLOR.lerp(SMOKE_COOL, (1 - ageFade) * 0.4 + heightRatio * 0.3);

            colors[i3] = TEMP_COLOR.r;
            colors[i3 + 1] = TEMP_COLOR.g;
            colors[i3 + 2] = TEMP_COLOR.b;

            /* Size grows as smoke rises and disperses */
            sizes[index] = (4 + motion.density * 4 + heightRatio * 8)
                * (0.7 + motion.emissionLevel * 0.5);
        }

        geometry.attributes.position.needsUpdate = true;
        geometry.attributes.color.needsUpdate = true;
        geometry.attributes.size.needsUpdate = true;

        /* Gentle group sway */
        group.rotation.y = Math.sin(time * 0.15) * 0.03;
        group.userData.smokeState = profile.key;
        group.userData.emissionLevel = motion.emissionLevel;
    }

    function dispose() {
        geometry.dispose();
        disposeMaterial(material);
    }

    return { group, update, dispose };
}
