import * as THREE from "../three.module.min.js";
import {
    clamp,
    computeProductScale,
    damp,
    disposeObject3D,
    getKilnPalette,
    measureObjectBounds,
    normalizeTelemetry,
} from "./kiln-scene-helpers.js";
import { createSmokeSystem } from "./kiln-scene-effects.js";

const BURNER_CAD_MODEL_URL = new URL("../models/burner-head-only.obj", import.meta.url).href;
const OBJ_LOADER_MODULE_URL = new URL("../vendor/three/examples/jsm/loaders/OBJLoader.js", import.meta.url).href;
const BURNER_CAD_TARGET_WIDTH = 26.8;
const BURNER_CAD_MOUNT_FACE_Y = 33.2;
let burnerCadTemplatePromise = null;
const BURNER_CAD_BOX = new THREE.Box3();
const BURNER_CAD_SIZE = new THREE.Vector3();
const BURNER_CAD_CENTER = new THREE.Vector3();
const BURNER_CAD_VERTEX = new THREE.Vector3();
const BURNER_CAD_COLOR = new THREE.Color();

function isBurnerCadDebugEnabled() {
    if (typeof window === "undefined") return false;
    if (!/^(127\.0\.0\.1|localhost)$/.test(window.location.hostname)) return false;
    const params = new URLSearchParams(window.location.search);
    return params.has("debugCad") || window.localStorage?.getItem("kiln-debug-cad") === "1";
}

function sampleBurnerCadColor(x, y, z) {
    const r = Math.hypot(x, z);
    const steelDark = new THREE.Color(0x6b6866);
    const steelBase = new THREE.Color(0xcfd0d0);
    const steelLight = new THREE.Color(0xe7e3de);
    const copperBase = new THREE.Color(0xbc8a6d);
    const copperLight = new THREE.Color(0xd1a184);
    const copperDark = new THREE.Color(0x6d412f);
    const holeDark = new THREE.Color(0x34160e);
    const goldBase = new THREE.Color(0xb8a15d);
    const goldLight = new THREE.Color(0xd0bc75);
    const screwBase = new THREE.Color(0xb4b9c0);
    const shade = clamp((x + 22) / 44, 0, 1);

    if (y > 26.6) {
        if (r > 9.55) {
            return BURNER_CAD_COLOR.copy(steelDark).lerp(steelLight, shade * 0.92);
        }
        if (r > 5.9) {
            return BURNER_CAD_COLOR.copy(copperBase).lerp(copperLight, shade * 0.78);
        }
        if (r > 4.95) {
            return BURNER_CAD_COLOR.copy(holeDark).lerp(copperDark, 0.18 + shade * 0.2);
        }
        if (r > 3.55) {
            return BURNER_CAD_COLOR.copy(steelBase).lerp(steelLight, shade * 0.85);
        }
        if (r > 2.4) {
            return BURNER_CAD_COLOR.copy(new THREE.Color(0x8c8178)).lerp(new THREE.Color(0xb4a69a), shade * 0.72);
        }
        let isScrew = false;
        for (const gx of [-0.78, 0, 0.78]) {
            for (const gz of [-0.78, 0, 0.78]) {
                const d = Math.hypot(x - gx, z - gz);
                if (d < 0.14) {
                    return BURNER_CAD_COLOR.copy(holeDark);
                }
                if (d < 0.3) {
                    isScrew = true;
                }
            }
        }
        if (isScrew) {
            return BURNER_CAD_COLOR.copy(screwBase).lerp(steelLight, shade * 0.3);
        }
        return BURNER_CAD_COLOR.copy(goldBase).lerp(goldLight, shade * 0.6);
    }

    if (y > 18) {
        return BURNER_CAD_COLOR.copy(steelDark).lerp(steelBase, shade * 0.88);
    }
    if (y > -72) {
        return BURNER_CAD_COLOR.copy(new THREE.Color(0xb8bbb9)).lerp(new THREE.Color(0xe0dfdc), shade * 0.94);
    }
    if (r < 4.8) {
        return BURNER_CAD_COLOR.copy(new THREE.Color(0xabb2ba)).lerp(new THREE.Color(0xe2e8ee), shade * 0.8);
    }
    return BURNER_CAD_COLOR.copy(new THREE.Color(0xc6cbcf)).lerp(new THREE.Color(0xe6eaee), shade * 0.84);
}

function applyBurnerCadVertexColors(root) {
    const isLocalDebug = isBurnerCadDebugEnabled();
    root.updateMatrixWorld(true);
    root.traverse((child) => {
        if (!child.isMesh || !child.geometry?.attributes?.position) return;
        let geometry = child.geometry.clone();
        if (geometry.index) geometry = geometry.toNonIndexed();
        const position = geometry.getAttribute("position");
        const colors = new Float32Array(position.count * 3);
        for (let index = 0; index < position.count; index += 1) {
            BURNER_CAD_VERTEX.fromBufferAttribute(position, index).applyMatrix4(child.matrixWorld);
            const color = sampleBurnerCadColor(BURNER_CAD_VERTEX.x, BURNER_CAD_VERTEX.y, BURNER_CAD_VERTEX.z);
            colors[index * 3] = color.r;
            colors[index * 3 + 1] = color.g;
            colors[index * 3 + 2] = color.b;
        }
        geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
        child.geometry.dispose?.();
        child.geometry = geometry;
        child.material = isLocalDebug
            ? new THREE.MeshBasicMaterial({
                color: 0xff335a,
                transparent: true,
                opacity: 0.72,
                side: THREE.DoubleSide,
                depthWrite: false,
                depthTest: false,
            })
            : new THREE.MeshPhysicalMaterial({
                vertexColors: true,
                roughness: 0.28,
                metalness: 0.76,
                clearcoat: 0.18,
                clearcoatRoughness: 0.2,
                envMapIntensity: 1.14,
                side: THREE.DoubleSide,
            });
        child.renderOrder = isLocalDebug ? 2000 : 5;
    });
}

function normalizeBurnerCadModel(root) {
    root.rotation.x = -Math.PI * 0.5;
    root.updateMatrixWorld(true);
    BURNER_CAD_BOX.setFromObject(root);
    BURNER_CAD_BOX.getSize(BURNER_CAD_SIZE);
    const scale = BURNER_CAD_TARGET_WIDTH / Math.max(BURNER_CAD_SIZE.x, BURNER_CAD_SIZE.z, 1);
    root.scale.setScalar(scale);
    root.updateMatrixWorld(true);
    BURNER_CAD_BOX.setFromObject(root);
    BURNER_CAD_BOX.getCenter(BURNER_CAD_CENTER);
    root.position.x -= BURNER_CAD_CENTER.x;
    root.position.z -= BURNER_CAD_CENTER.z;
    root.position.y -= BURNER_CAD_BOX.max.y;
    root.updateMatrixWorld(true);
    BURNER_CAD_BOX.setFromObject(root);
    applyBurnerCadVertexColors(root);
    globalThis.__burnerCadTemplateStats = {
        size: {
            x: BURNER_CAD_SIZE.x,
            y: BURNER_CAD_SIZE.y,
            z: BURNER_CAD_SIZE.z,
        },
        center: {
            x: BURNER_CAD_CENTER.x,
            y: BURNER_CAD_CENTER.y,
            z: BURNER_CAD_CENTER.z,
        },
        targetWidth: BURNER_CAD_TARGET_WIDTH,
        normalizedBounds: {
            min: { x: BURNER_CAD_BOX.min.x, y: BURNER_CAD_BOX.min.y, z: BURNER_CAD_BOX.min.z },
            max: { x: BURNER_CAD_BOX.max.x, y: BURNER_CAD_BOX.max.y, z: BURNER_CAD_BOX.max.z },
        },
        mountFaceY: BURNER_CAD_MOUNT_FACE_Y,
    };
    return root;
}

function loadBurnerCadTemplate() {
    if (!burnerCadTemplatePromise) {
        burnerCadTemplatePromise = import(OBJ_LOADER_MODULE_URL)
            .then(({ OBJLoader }) => new Promise((resolve, reject) => {
                const loader = new OBJLoader();
                loader.load(BURNER_CAD_MODEL_URL, resolve, undefined, reject);
            }))
            .then((object) => normalizeBurnerCadModel(object))
        .catch((error) => {
            burnerCadTemplatePromise = null;
            globalThis.__burnerCadLoadError = String(error?.message || error);
            throw error;
        });
    }
    return burnerCadTemplatePromise;
}

const KILN_DIMENSIONS = {
    shellWidth: 126,
    shellDepth: 50,
    shellShoulderY: 68,
    shellBaseY: -60,
    chamberWidth: 94,
    chamberDepth: 36,
    chamberShoulderY: 56,
    chamberBaseY: -54,
    frontZ: 22,
    floorY: -52,
    rackWidth: 80,
    rackDepth: 20,
    chimneyY: 76,
};

const SHELF_LEVELS = Object.freeze([40, 16, -10, -36]);
const PRODUCT_POOL_LIMITS = Object.freeze({
    large: 8,
    small: 24,
});
const LAYOUT_TRANSITION_DURATION = 0.42;

function createSlotsForRow(shelfIndex, xs, scale, z = 0) {
    return xs.map((x, index) => ({
        x,
        shelfIndex,
        z,
        scale: scale * (1 - Math.abs(index - (xs.length - 1) * 0.5) * 0.015),
    }));
}

const PRODUCT_LAYOUTS = Object.freeze({
    "large-2": {
        key: "large-2",
        productType: "large",
        productCount: 2,
        activeShelfIndexes: [1, 2],
        slots: [
            { x: -23.5, shelfIndex: 2, z: -5.6, scale: 1.74 },
            { x: 23.5, shelfIndex: 2, z: -4.2, scale: 1.68 },
        ],
        arrowRows: [10, -8, -24],
        burnerY: -68,
        burnerX: 36,
        burnerZ: 24,
        flameHeight: 44,
        flameRadius: 10.5,
    },
    "small-4": {
        key: "small-4",
        productType: "small",
        productCount: 4,
        activeShelfIndexes: [2, 3],
        slots: [
            { x: -13.5, shelfIndex: 2, z: 0, scale: 1.3 },
            { x: 13.5, shelfIndex: 2, z: 0, scale: 1.24 },
            { x: -13.5, shelfIndex: 3, z: 0, scale: 1.16 },
            { x: 13.5, shelfIndex: 3, z: 0, scale: 1.12 },
        ],
        arrowRows: [22, 4, -14, -30],
        burnerY: -68,
        burnerX: 36,
        burnerZ: 24,
        flameHeight: 52,
        flameRadius: 11.6,
    },
    "large-8": {
        key: "large-8",
        productType: "large",
        productCount: 8,
        activeShelfIndexes: [1, 2],
        slots: [
            ...createSlotsForRow(1, [-28, -9.5, 9.5, 28], 1.08),
            ...createSlotsForRow(2, [-28, -9.5, 9.5, 28], 1.02),
        ],
        arrowRows: [14, -2, -18],
        burnerY: -68,
        burnerX: 36,
        burnerZ: 24,
        flameHeight: 74,
        flameRadius: 16.4,
    },
    "small-24": {
        key: "small-24",
        productType: "small",
        productCount: 24,
        activeShelfIndexes: [0, 1, 2, 3],
        slots: [
            ...createSlotsForRow(0, [-30, -18, -6, 6, 18, 30], 0.86),
            ...createSlotsForRow(1, [-30, -18, -6, 6, 18, 30], 0.84),
            ...createSlotsForRow(2, [-30, -18, -6, 6, 18, 30], 0.82),
            ...createSlotsForRow(3, [-30, -18, -6, 6, 18, 30], 0.8),
        ],
        arrowRows: [28, 12, -4, -20],
        burnerY: -68,
        burnerX: 36,
        burnerZ: 24,
        flameHeight: 50,
        flameRadius: 11.2,
    },
    large: {
        key: "large",
        productType: "large",
        productCount: 2,
        activeShelfIndexes: [1],
        slots: [
            { x: -14, shelfIndex: 1, z: 0, scale: 1.9 },
            { x: 14, shelfIndex: 1, z: 0, scale: 1.76 },
        ],
        arrowRows: [10, -8, -24],
        burnerY: -68,
        burnerX: 36,
        burnerZ: 24,
        flameHeight: 60,
        flameRadius: 13.6,
    },
    small: {
        key: "small",
        productType: "small",
        productCount: 4,
        activeShelfIndexes: [2, 3],
        slots: [
            { x: -13.5, shelfIndex: 2, z: 0, scale: 1.3 },
            { x: 13.5, shelfIndex: 2, z: 0, scale: 1.24 },
            { x: -13.5, shelfIndex: 3, z: 0, scale: 1.16 },
            { x: 13.5, shelfIndex: 3, z: 0, scale: 1.12 },
        ],
        arrowRows: [22, 4, -14, -30],
        burnerY: -68,
        burnerX: 36,
        burnerZ: 24,
        flameHeight: 56,
        flameRadius: 12.8,
    },
});

const SHELF_BASE_COLOR = new THREE.Color(0x887561);
const FIT_BOX = new THREE.Box3();
const FIT_SIZE = new THREE.Vector3();
const FIT_CENTER = new THREE.Vector3();
const FIT_TARGET = new THREE.Vector3();
const FIT_CAMERA = new THREE.Vector3();
const FIT_CAMERA_TARGET = new THREE.Vector3();
const FIT_MIN = new THREE.Vector3();
const FIT_MAX = new THREE.Vector3();
const ORBIT_OFFSET = new THREE.Vector3();
const DEFAULT_ORBIT_YAW = -0.34;
const DEFAULT_ORBIT_PITCH = 0.2;
const EXCLUDE_FROM_FIT_BOUNDS = "excludeFromFitBounds";
const NOZZLE_RING_MAJOR_RADIUS = 7.18;
const NOZZLE_RING_TUBE_RADIUS = 0.38;
const NOZZLE_RING_OUTER_RADIUS = NOZZLE_RING_MAJOR_RADIUS + NOZZLE_RING_TUBE_RADIUS;
const OUTER_NOZZLE_COUNT = 12;
const CORE_NOZZLE_COUNT = 9;
const FLAME_VOLUME_BASE_RADIUS = 0.7;
const DETAIL_TEXTURE_SIZE = 256;

function fract(value) {
    return value - Math.floor(value);
}

function hashNoise(x, y, seed = 0) {
    return fract(Math.sin(x * 127.1 + y * 311.7 + seed * 74.7) * 43758.5453123);
}

function layeredNoise(x, y, seed = 0) {
    let value = 0;
    let amplitude = 0.55;
    let frequency = 1;
    let total = 0;
    for (let octave = 0; octave < 4; octave += 1) {
        value += hashNoise(x * frequency, y * frequency, seed + octave * 19.7) * amplitude;
        total += amplitude;
        frequency *= 2.1;
        amplitude *= 0.5;
    }
    return total > 0 ? value / total : 0;
}

function createCanvasTexture(size, painter, options = {}) {
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext("2d");
    if (!context) {
        throw new Error("Canvas 2D context unavailable.");
    }
    painter(context, size);
    const texture = new THREE.CanvasTexture(canvas);
    texture.wrapS = options.wrapS ?? THREE.RepeatWrapping;
    texture.wrapT = options.wrapT ?? THREE.RepeatWrapping;
    texture.repeat.set(options.repeatX ?? 1, options.repeatY ?? 1);
    texture.anisotropy = options.anisotropy ?? 8;
    texture.colorSpace = options.colorSpace ?? THREE.NoColorSpace;
    texture.needsUpdate = true;
    return texture;
}

function paintGrayscaleTexture(context, size, sampler) {
    const image = context.createImageData(size, size);
    const data = image.data;
    for (let y = 0; y < size; y += 1) {
        for (let x = 0; x < size; x += 1) {
            const offset = (y * size + x) * 4;
            const value = Math.round(clamp(sampler(x / size, y / size, x, y), 0, 1) * 255);
            data[offset] = value;
            data[offset + 1] = value;
            data[offset + 2] = value;
            data[offset + 3] = 255;
        }
    }
    context.putImageData(image, 0, 0);
}

function createCeramicDetailTexture() {
    return createCanvasTexture(DETAIL_TEXTURE_SIZE, (context, size) => {
        paintGrayscaleTexture(context, size, (u, v) => {
            const bodyNoise = layeredNoise(u * 7.5, v * 12.5, 0.8);
            const glazeNoise = layeredNoise(u * 22, v * 28, 4.6);
            const wheelMarks = 0.5 + 0.5 * Math.sin(v * 168 + bodyNoise * 9.2);
            const dripMask = Math.pow(Math.max(0, 0.82 - v), 2.8);
            const drips = (0.5 + 0.5 * Math.sin(u * 38 + glazeNoise * 7.8)) * dripMask * 0.1;
            const pores = hashNoise(u * 180, v * 180, 8.9) > 0.992 ? -0.14 : 0;
            return (
                0.68 +
                (bodyNoise - 0.5) * 0.16 +
                (glazeNoise - 0.5) * 0.12 +
                (wheelMarks - 0.5) * 0.08 +
                drips +
                pores
            );
        });
    }, {
        repeatX: 2.2,
        repeatY: 2.8,
    });
}

function createBrickColorTexture() {
    return createCanvasTexture(DETAIL_TEXTURE_SIZE, (context, size) => {
        const mortar = "#b68d67";
        const base = "#c67b47";
        const hot = "#e39a63";
        const soot = "#4e3426";
        context.fillStyle = mortar;
        context.fillRect(0, 0, size, size);

        const rows = 7;
        const rowHeight = size / rows;
        for (let row = 0; row < rows; row += 1) {
            const columns = row % 2 === 0 ? 5 : 6;
            const brickWidth = size / columns;
            const offset = row % 2 === 0 ? 0 : brickWidth * 0.5;
            for (let column = -1; column < columns; column += 1) {
                const x = column * brickWidth + offset;
                const y = row * rowHeight;
                const fill = layeredNoise(column * 0.42, row * 0.68, 1.8);
                const wear = layeredNoise(column * 1.8, row * 1.2, 8.4);
                const tone = fill > 0.54 ? hot : base;
                context.fillStyle = tone;
                context.fillRect(x + 3, y + 3, brickWidth - 6, rowHeight - 6);

                const sootShade = layeredNoise(column * 2.4, row * 3.4, 11.7);
                if (sootShade > 0.58) {
                    context.fillStyle = `rgba(78,52,38,${0.08 + (sootShade - 0.58) * 0.5})`;
                    context.fillRect(x + 3, y + 3, brickWidth - 6, rowHeight - 6);
                }

                const glazeTrail = Math.max(0, 0.82 - wear) * 0.34;
                if (glazeTrail > 0.02) {
                    const gradient = context.createLinearGradient(0, y + 4, 0, y + rowHeight - 4);
                    gradient.addColorStop(0, `rgba(255,214,176,${glazeTrail * 0.18})`);
                    gradient.addColorStop(0.55, `rgba(255,188,124,${glazeTrail * 0.26})`);
                    gradient.addColorStop(1, "rgba(0,0,0,0)");
                    context.fillStyle = gradient;
                    context.fillRect(x + brickWidth * 0.32, y + 4, brickWidth * 0.18, rowHeight - 8);
                }

                const chipShade = layeredNoise(column * 5.6, row * 4.4, 14.2);
                if (chipShade > 0.66) {
                    context.fillStyle = "rgba(244,216,186,0.2)";
                    context.fillRect(x + brickWidth * 0.1, y + rowHeight * 0.14, brickWidth * 0.16, rowHeight * 0.1);
                }
            }
        }
    }, {
        repeatX: 1.5,
        repeatY: 1.2,
        colorSpace: THREE.SRGBColorSpace,
    });
}

function createBrickReliefTexture() {
    return createCanvasTexture(DETAIL_TEXTURE_SIZE, (context, size) => {
        paintGrayscaleTexture(context, size, (u, v) => {
            const rows = 7;
            const row = Math.floor(v * rows);
            const rowParity = row % 2;
            const columns = rowParity === 0 ? 5 : 6;
            const brickWidth = 1 / columns;
            const offset = rowParity === 0 ? 0 : brickWidth * 0.5;
            const shiftedU = ((u + offset) % 1 + 1) % 1;
            const brickX = shiftedU % brickWidth;
            const mortarX = Math.min(brickX, brickWidth - brickX);
            const mortarY = Math.min(v * rows - row, row + 1 - v * rows);
            const mortarMask = mortarX < brickWidth * 0.06 || mortarY < 0.08;
            const grain = layeredNoise(u * 18, v * 12, 4.2);
            const pits = hashNoise(u * 146, v * 146, 10.8) > 0.993 ? -0.18 : 0;
            const body = 0.62 + (grain - 0.5) * 0.18 + pits;
            return mortarMask ? 0.34 : body;
        });
    }, {
        repeatX: 1.5,
        repeatY: 1.2,
    });
}

function createStoneDetailTexture() {
    return createCanvasTexture(DETAIL_TEXTURE_SIZE, (context, size) => {
        paintGrayscaleTexture(context, size, (u, v) => {
            const largeNoise = layeredNoise(u * 5.5, v * 5.5, 1.9);
            const microNoise = layeredNoise(u * 24, v * 24, 7.3);
            const sediment = 0.5 + 0.5 * Math.sin((u + v) * 22 + largeNoise * 5.6);
            const pits = hashNoise(u * 128, v * 128, 12.1) > 0.986 ? -0.2 : 0;
            return 0.54 + (largeNoise - 0.5) * 0.28 + (microNoise - 0.5) * 0.16 + (sediment - 0.5) * 0.1 + pits;
        });
    }, {
        repeatX: 1.8,
        repeatY: 1.8,
    });
}

function createMetalDetailTexture() {
    return createCanvasTexture(DETAIL_TEXTURE_SIZE, (context, size) => {
        paintGrayscaleTexture(context, size, (u, v) => {
            const brushed = 0.5 + 0.5 * Math.sin(v * 620 + layeredNoise(u * 10, v * 18, 6.4) * 8);
            const scuffs = layeredNoise(u * 42, v * 9, 3.8);
            const pits = hashNoise(u * 220, v * 52, 2.4) > 0.996 ? -0.26 : 0;
            return 0.52 + (brushed - 0.5) * 0.18 + (scuffs - 0.5) * 0.1 + pits;
        });
    }, {
        repeatX: 1,
        repeatY: 4.6,
    });
}

function createSoftShadowTexture() {
    return createCanvasTexture(256, (context, size) => {
        const gradient = context.createRadialGradient(
            size * 0.5,
            size * 0.5,
            size * 0.12,
            size * 0.5,
            size * 0.5,
            size * 0.5
        );
        gradient.addColorStop(0, "rgba(0,0,0,0.85)");
        gradient.addColorStop(0.45, "rgba(0,0,0,0.42)");
        gradient.addColorStop(1, "rgba(0,0,0,0)");
        context.clearRect(0, 0, size, size);
        context.fillStyle = gradient;
        context.fillRect(0, 0, size, size);
    }, {
        wrapS: THREE.ClampToEdgeWrapping,
        wrapT: THREE.ClampToEdgeWrapping,
        repeatX: 1,
        repeatY: 1,
        anisotropy: 2,
    });
}

function createStudioEnvironmentMap(renderer) {
    const canvas = document.createElement("canvas");
    canvas.width = 1024;
    canvas.height = 512;
    const context = canvas.getContext("2d");
    if (!context) {
        throw new Error("Canvas 2D context unavailable.");
    }

    const baseGradient = context.createLinearGradient(0, 0, 0, canvas.height);
    baseGradient.addColorStop(0, "#16222d");
    baseGradient.addColorStop(0.42, "#314454");
    baseGradient.addColorStop(0.6, "#7b7468");
    baseGradient.addColorStop(1, "#17130f");
    context.fillStyle = baseGradient;
    context.fillRect(0, 0, canvas.width, canvas.height);

    const coolPanel = context.createRadialGradient(
        canvas.width * 0.26,
        canvas.height * 0.18,
        18,
        canvas.width * 0.26,
        canvas.height * 0.18,
        canvas.width * 0.22
    );
    coolPanel.addColorStop(0, "rgba(183, 228, 255, 0.95)");
    coolPanel.addColorStop(0.42, "rgba(112, 188, 255, 0.38)");
    coolPanel.addColorStop(1, "rgba(0, 0, 0, 0)");
    context.fillStyle = coolPanel;
    context.fillRect(0, 0, canvas.width, canvas.height);

    const warmPanel = context.createRadialGradient(
        canvas.width * 0.76,
        canvas.height * 0.22,
        24,
        canvas.width * 0.76,
        canvas.height * 0.22,
        canvas.width * 0.26
    );
    warmPanel.addColorStop(0, "rgba(255, 221, 176, 0.86)");
    warmPanel.addColorStop(0.5, "rgba(255, 154, 92, 0.24)");
    warmPanel.addColorStop(1, "rgba(0, 0, 0, 0)");
    context.fillStyle = warmPanel;
    context.fillRect(0, 0, canvas.width, canvas.height);

    const floorBounce = context.createLinearGradient(0, canvas.height * 0.56, 0, canvas.height);
    floorBounce.addColorStop(0, "rgba(255, 204, 148, 0)");
    floorBounce.addColorStop(1, "rgba(255, 190, 128, 0.3)");
    context.fillStyle = floorBounce;
    context.fillRect(0, 0, canvas.width, canvas.height);

    const environmentTexture = new THREE.CanvasTexture(canvas);
    environmentTexture.mapping = THREE.EquirectangularReflectionMapping;
    environmentTexture.colorSpace = THREE.SRGBColorSpace;
    const pmremGenerator = new THREE.PMREMGenerator(renderer);
    pmremGenerator.compileEquirectangularShader();
    const environmentMap = pmremGenerator.fromEquirectangular(environmentTexture).texture;
    environmentTexture.dispose();
    pmremGenerator.dispose();
    return environmentMap;
}

function readSize(options, mount) {
    const width = Math.max(1, Number(options?.width) || mount?.clientWidth || 1);
    const height = Math.max(1, Number(options?.height) || mount?.clientHeight || 1);
    return { width, height };
}

function createRenderer(width, height) {
    const renderer = new THREE.WebGLRenderer({
        antialias: true,
        alpha: true,
        powerPreference: "high-performance",
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(width, height, false);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.12;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.setClearColor(0x01050a, 0);
    return renderer;
}

function archHeight(width, shoulderY) {
    return shoulderY + width * 0.5;
}

function createArchShape(width, shoulderY) {
    const halfWidth = width * 0.5;
    const shape = new THREE.Shape();
    shape.moveTo(-halfWidth, 0);
    shape.lineTo(halfWidth, 0);
    shape.lineTo(halfWidth, shoulderY);
    shape.absarc(0, shoulderY, halfWidth, 0, Math.PI, false);
    shape.lineTo(-halfWidth, 0);
    return shape;
}

function createArchRingShape(outerWidth, outerShoulderY, innerWidth, innerShoulderY) {
    const shape = createArchShape(outerWidth, outerShoulderY);
    const inner = new THREE.Path();
    inner.setFromPoints(createArchShape(innerWidth, innerShoulderY).getPoints(40).reverse());
    shape.holes.push(inner);
    return shape;
}

function createArchExtrudeGeometry(width, shoulderY, depth) {
    const geometry = new THREE.ExtrudeGeometry(createArchShape(width, shoulderY), {
        depth,
        bevelEnabled: false,
        steps: 1,
        curveSegments: 40,
    });
    geometry.translate(0, 0, -depth * 0.5);
    return geometry;
}

function createArchRingGeometry(outerWidth, outerShoulderY, innerWidth, innerShoulderY, depth) {
    const geometry = new THREE.ExtrudeGeometry(
        createArchRingShape(outerWidth, outerShoulderY, innerWidth, innerShoulderY),
        {
            depth,
            bevelEnabled: false,
            steps: 1,
            curveSegments: 40,
        }
    );
    geometry.translate(0, 0, -depth * 0.5);
    return geometry;
}

function createArchPanelGeometry(width, shoulderY) {
    return new THREE.ShapeGeometry(createArchShape(width, shoulderY), 40);
}

function createTechEdge(geometry, color = 0x89ddff, opacity = 0.26) {
    return new THREE.LineSegments(
        new THREE.EdgesGeometry(geometry, 26),
        new THREE.LineBasicMaterial({
            color,
            transparent: true,
            opacity,
            depthWrite: false,
            blending: THREE.AdditiveBlending,
            toneMapped: false,
        })
    );
}

function createLargeProductGeometry() {
    const points = [
        new THREE.Vector2(0, 0),
        new THREE.Vector2(1.24, 0),
        new THREE.Vector2(1.88, 0.4),
        new THREE.Vector2(2.52, 1.3),
        new THREE.Vector2(3.08, 3.5),
        new THREE.Vector2(3.18, 6.5),
        new THREE.Vector2(2.64, 8.9),
        new THREE.Vector2(2.12, 10.9),
        new THREE.Vector2(1.62, 13.2),
        new THREE.Vector2(1.74, 15.6),
        new THREE.Vector2(2.48, 17.4),
        new THREE.Vector2(2.14, 18.1),
        new THREE.Vector2(1.34, 18.58),
        new THREE.Vector2(0.64, 18.78),
        new THREE.Vector2(0, 18.78),
    ];
    const geometry = new THREE.LatheGeometry(points, 36);
    geometry.translate(0, -9.39, 0);
    return geometry;
}

function createSmallProductGeometry() {
    const points = [
        new THREE.Vector2(0, 0),
        new THREE.Vector2(1.28, 0.02),
        new THREE.Vector2(1.9, 0.42),
        new THREE.Vector2(2.36, 1.7),
        new THREE.Vector2(2.44, 4.8),
        new THREE.Vector2(2.02, 7.1),
        new THREE.Vector2(1.48, 8.76),
        new THREE.Vector2(1.04, 10.22),
        new THREE.Vector2(1.18, 11.3),
        new THREE.Vector2(1.52, 11.96),
        new THREE.Vector2(1.1, 12.42),
        new THREE.Vector2(0.44, 12.68),
        new THREE.Vector2(0, 12.68),
    ];
    const geometry = new THREE.LatheGeometry(points, 32);
    geometry.translate(0, -6.34, 0);
    return geometry;
}

function assignFocusGroup(object, focusGroup) {
    object.userData.focusGroup = focusGroup;
    object.traverse((node) => {
        if (node.isMesh || node.isInstancedMesh || node.isLine || node.isPoints) {
            node.userData.focusGroup = focusGroup;
        }
    });
    return object;
}

function normalizeFocusLayer(layerKey) {
    const key = String(layerKey || "all").trim().toLowerCase();
    if (["shell", "structure", "kiln", "rack", "shelves"].includes(key)) return "structure";
    if (["product", "products", "ware"].includes(key)) return "products";
    if (["radiation", "heat", "arrows"].includes(key)) return "radiation";
    if (["flame", "flames", "burner", "burners"].includes(key)) return "flame";
    return "all";
}

function excludeFromFitBounds(object) {
    if (object) {
        object.userData[EXCLUDE_FROM_FIT_BOUNDS] = true;
    }
    return object;
}

function resolveProductLayout(productType, productCount) {
    const normalizedType = productType === "large" ? "large" : "small";
    const explicitKey = `${normalizedType}-${Math.max(1, Math.round(Number(productCount) || 0))}`;
    if (PRODUCT_LAYOUTS[explicitKey]) {
        return PRODUCT_LAYOUTS[explicitKey];
    }
    return PRODUCT_LAYOUTS[normalizedType];
}

function createFlameMaterial(color, opacity, blending = THREE.NormalBlending) {
    return new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity,
        depthWrite: false,
        blending,
        toneMapped: false,
        side: THREE.DoubleSide,
    });
}

function createFlameShaderMaterial(seed = 0) {
    return new THREE.ShaderMaterial({
        uniforms: {
            phase: { value: 0 },
            agitation: { value: 0.12 },
            intensity: { value: 0.5 },
            orangeRatio: { value: 0.5 },
            blueRatio: { value: 0.5 },
            seed: { value: seed },
        },
        vertexShader: `
            uniform float phase;
            uniform float agitation;
            uniform float intensity;
            uniform float seed;
            varying vec2 vUv;
            varying vec3 vViewDir;
            varying vec3 vNormal;

            vec4 permute(vec4 x) { return mod(((x * 34.0) + 1.0) * x, 289.0); }
            vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }

            float snoise(vec3 v) {
                const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
                const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
                vec3 i = floor(v + dot(v, C.yyy));
                vec3 x0 = v - i + dot(i, C.xxx);
                vec3 g = step(x0.yzx, x0.xyz);
                vec3 l = 1.0 - g;
                vec3 i1 = min(g.xyz, l.zxy);
                vec3 i2 = max(g.xyz, l.zxy);
                vec3 x1 = x0 - i1 + C.xxx;
                vec3 x2 = x0 - i2 + C.yyy;
                vec3 x3 = x0 - D.yyy;
                i = mod(i, 289.0);
                vec4 p = permute(
                    permute(
                        permute(i.z + vec4(0.0, i1.z, i2.z, 1.0)) +
                        i.y + vec4(0.0, i1.y, i2.y, 1.0)
                    ) +
                    i.x + vec4(0.0, i1.x, i2.x, 1.0)
                );
                vec3 ns = (1.0 / 7.0) * D.wyz - D.xzx;
                vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
                vec4 x_ = floor(j * ns.z);
                vec4 y_ = floor(j - 7.0 * x_);
                vec4 x = x_ * ns.x + ns.yyyy;
                vec4 y = y_ * ns.x + ns.yyyy;
                vec4 h = 1.0 - abs(x) - abs(y);
                vec4 b0 = vec4(x.xy, y.xy);
                vec4 b1 = vec4(x.zw, y.zw);
                vec4 s0 = floor(b0) * 2.0 + 1.0;
                vec4 s1 = floor(b1) * 2.0 + 1.0;
                vec4 sh = -step(h, vec4(0.0));
                vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
                vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
                vec3 p0 = vec3(a0.xy, h.x);
                vec3 p1 = vec3(a0.zw, h.y);
                vec3 p2 = vec3(a1.xy, h.z);
                vec3 p3 = vec3(a1.zw, h.w);
                vec4 norm = taylorInvSqrt(vec4(
                    dot(p0, p0),
                    dot(p1, p1),
                    dot(p2, p2),
                    dot(p3, p3)
                ));
                p0 *= norm.x;
                p1 *= norm.y;
                p2 *= norm.z;
                p3 *= norm.w;
                vec4 m = max(0.6 - vec4(
                    dot(x0, x0),
                    dot(x1, x1),
                    dot(x2, x2),
                    dot(x3, x3)
                ), 0.0);
                m = m * m;
                return 42.0 * dot(m * m, vec4(
                    dot(p0, x0),
                    dot(p1, x1),
                    dot(p2, x2),
                    dot(p3, x3)
                ));
            }

            void main() {
                vUv = uv;
                float h = uv.y;
                vec3 pos = position;
                float flowTime = phase * (0.92 + agitation * 1.7) + seed * 4.2;
                float bodyNoise = snoise(vec3(
                    pos.x * 3.35 + seed * 1.6,
                    pos.y * 2.6 - flowTime,
                    pos.z * 3.35 + seed * 2.1
                ));
                float radialDistortion = 0.06 + agitation * 0.34;
                pos.x += bodyNoise * h * radialDistortion;
                pos.z += bodyNoise * h * radialDistortion;
                pos.y += snoise(vec3(seed * 2.0, phase * 0.68 + seed * 3.0, 0.0)) * h * (0.08 + agitation * 0.42);

                vec4 mvPosition = modelViewMatrix * vec4(pos, 1.0);
                vViewDir = -mvPosition.xyz;
                vNormal = normalMatrix * normal;
                gl_Position = projectionMatrix * mvPosition;
            }
        `,
        fragmentShader: `
            uniform float phase;
            uniform float agitation;
            uniform float intensity;
            uniform float orangeRatio;
            uniform float blueRatio;
            uniform float seed;
            varying vec2 vUv;
            varying vec3 vViewDir;
            varying vec3 vNormal;

            vec3 permute(vec3 x) { return mod(((x * 34.0) + 1.0) * x, 289.0); }

            float snoise(vec2 v) {
                const vec4 C = vec4(
                    0.211324865405187,
                    0.366025403784439,
                    -0.577350269189626,
                    0.024390243902439
                );
                vec2 i = floor(v + dot(v, C.yy));
                vec2 x0 = v - i + dot(i, C.xx);
                vec2 i1 = x0.x > x0.y ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
                vec4 x12 = x0.xyxy + C.xxzz;
                x12.xy -= i1;
                i = mod(i, 289.0);
                vec3 p = permute(
                    permute(i.y + vec3(0.0, i1.y, 1.0)) +
                    i.x + vec3(0.0, i1.x, 1.0)
                );
                vec3 m = max(
                    0.5 - vec3(
                        dot(x0, x0),
                        dot(x12.xy, x12.xy),
                        dot(x12.zw, x12.zw)
                    ),
                    0.0
                );
                m = m * m;
                m = m * m;
                vec3 x = 2.0 * fract(p * C.www) - 1.0;
                vec3 h = abs(x) - 0.5;
                vec3 ox = floor(x + 0.5);
                vec3 a0 = x - ox;
                m *= 1.79284291400159 - 0.85373472095314 * (a0 * a0 + h * h);
                vec3 g;
                g.x = a0.x * x0.x + h.x * x0.y;
                g.yz = a0.yz * x12.xz + h.yz * x12.yw;
                return 130.0 * dot(m, g);
            }

            void main() {
                float h = vUv.y;
                vec3 N = normalize(vNormal);
                vec3 V = normalize(vViewDir);
                float rim = 1.0 - abs(dot(N, V));

                vec3 blueColor = mix(vec3(0.02, 0.28, 0.98), vec3(0.08, 0.56, 1.0), blueRatio) * 1.08;
                vec3 emberColor = mix(vec3(0.92, 0.08, 0.0), vec3(1.0, 0.24, 0.02), orangeRatio) * 1.08;
                vec3 coreColor = mix(vec3(1.0, 0.54, 0.0), vec3(1.0, 0.78, 0.22), orangeRatio) * 1.06;
                vec3 whiteHotColor = vec3(1.0, 0.96, 0.88);

                float baseBlueMask = 1.0 - smoothstep(0.03, 0.17, h);
                float bodyMask = smoothstep(0.06, 0.2, h) * (1.0 - smoothstep(0.6, 1.0, h));
                float radialCenter = 1.0 - smoothstep(0.08, 0.74, abs(vUv.x - 0.5) * 2.0);
                vec3 finalColor = mix(emberColor, blueColor, baseBlueMask);
                finalColor = mix(finalColor, coreColor, bodyMask * (0.44 + orangeRatio * 0.24));

                float tearTime = phase * (0.76 + agitation * 1.18) + seed * 6.0;
                float noise = snoise(vec2(
                    vUv.x * mix(7.0, 11.6, agitation) + seed * 2.0,
                    vUv.y * mix(6.2, 9.8, agitation) - tearTime
                )) * 0.5 + 0.5;
                float edgeNoise = snoise(vec2(
                    vUv.x * mix(13.0, 17.0, agitation) - seed * 3.4,
                    vUv.y * mix(10.0, 14.0, agitation) - tearTime * 1.22
                )) * 0.5 + 0.5;
                float whiteMask = radialCenter
                    * (1.0 - smoothstep(0.04, 0.34, h))
                    * (0.36 + intensity * 0.44);
                finalColor = mix(finalColor, whiteHotColor, whiteMask);
                finalColor += coreColor * radialCenter * (0.06 + orangeRatio * 0.08) * (1.0 - smoothstep(0.58, 0.94, h));

                float silhouette = 1.0 - smoothstep(
                    0.44,
                    1.02,
                    abs(vUv.x - 0.5) * 2.0 + (edgeNoise - 0.5) * (0.38 + h * 0.48)
                );
                float solidBase = 1.0 - smoothstep(0.0, 0.26, h);
                float alpha = mix(0.22 + noise * 0.42, 0.92, solidBase);
                alpha += whiteMask * 0.28;
                alpha *= silhouette;
                alpha *= 1.0 - smoothstep(0.78, 1.0, h);
                alpha *= mix(1.0, 0.52, rim);
                alpha *= 0.84 + intensity * 0.26;
                alpha = max(alpha, baseBlueMask * 0.78 * (0.72 + blueRatio * 0.18));

                if (alpha <= 0.001) discard;
                gl_FragColor = vec4(finalColor, alpha);
            }
        `,
        transparent: true,
        depthWrite: false,
        blending: THREE.NormalBlending,
        toneMapped: false,
        side: THREE.DoubleSide,
    });
}

function setAnchoredFlameVolumeTransform(
    mesh,
    radiusX,
    height,
    radiusZ,
    baseY,
    offsetX = 0,
    offsetZ = 0,
    tiltX = 0,
    tiltZ = 0
) {
    mesh.scale.set(radiusX, height, radiusZ);
    mesh.position.set(offsetX, baseY, offsetZ);
    mesh.rotation.x = tiltX;
    mesh.rotation.z = tiltZ;
}

function computeFlameResponseBoostTarget(nextRuntime, previousRuntime) {
    const previous = previousRuntime || nextRuntime;
    const nextProfile = nextRuntime.flameProfile || {};
    const previousProfile = previous.flameProfile || nextProfile;
    const temperatureDelta = clamp(Math.abs((nextRuntime.temperature ?? 0) - (previous.temperature ?? nextRuntime.temperature)) / 180, 0, 1);
    const radiationDelta = clamp(Math.abs((nextRuntime.radiationIntensity ?? 0) - (previous.radiationIntensity ?? nextRuntime.radiationIntensity)) / 0.28, 0, 1);
    const flameDelta = clamp(Math.abs((nextRuntime.flame?.intensity ?? 0) - (previous.flame?.intensity ?? (nextRuntime.flame?.intensity ?? 0))) / 0.35, 0, 1);
    const plumeDelta = clamp(Math.abs((nextProfile.plumeRise ?? 0) - (previousProfile.plumeRise ?? (nextProfile.plumeRise ?? 0))) / 0.28, 0, 1);
    const pulseDelta = clamp(Math.abs((nextProfile.pulseSpeed ?? 0) - (previousProfile.pulseSpeed ?? (nextProfile.pulseSpeed ?? 0))) / 0.03, 0, 1);
    return clamp(
        temperatureDelta * 0.34 +
        radiationDelta * 0.18 +
        flameDelta * 0.18 +
        plumeDelta * 0.16 +
        pulseDelta * 0.14,
        0,
        1
    );
}

function deriveFlameDynamicsTargets(runtime, responseBoostTarget = 0) {
    const activeLayout = resolveProductLayout(runtime.productType, runtime.productCount);
    const flame = runtime.flame || {};
    const flameProfile = runtime.flameProfile || {};
    const flameIntensity = clamp(flame.intensity ?? 0.5, 0.08, 1);
    const nozzleScale = 0.9 + flameIntensity * 0.18 + activeLayout.flameRadius * 0.012;
    const nozzleAnchorRadius = NOZZLE_RING_OUTER_RADIUS * nozzleScale * 0.96;
    const chamberHeat = flameProfile.chamberHeat ?? 0.78;
    const plumeRise = flameProfile.plumeRise ?? 0.42;
    const burnerRadius = flameProfile.burnerRadius ?? 0.36;

    return {
        heightTarget: activeLayout.flameHeight * plumeRise * (1.02 + flameIntensity * 0.72) * (0.92 + chamberHeat * 0.42),
        radiusTarget: nozzleAnchorRadius * clamp(0.74 + burnerRadius * 0.66 + chamberHeat * 0.12, 0.74, 1.18),
        agitationTarget: clamp(
            0.12 +
            (flameProfile.shimmer ?? 0.12) * 0.42 +
            (flameProfile.haze ?? 0.26) * 0.24 +
            responseBoostTarget * 0.32,
            0.12,
            0.68
        ),
        phaseSpeedTarget: clamp(
            0.86 + (flameProfile.pulseSpeed ?? 0.026) * 18.0 + responseBoostTarget * 1.4,
            0.86,
            2.8
        ),
        responseBoostTarget,
        nozzleScale,
        nozzleAnchorRadius,
    };
}

function createInitialFlameDynamics(runtime) {
    const targets = deriveFlameDynamicsTargets(runtime, 0);
    return {
        ...targets,
        height: targets.heightTarget,
        radius: targets.radiusTarget,
        agitation: targets.agitationTarget,
        phaseSpeed: targets.phaseSpeedTarget,
        responseBoost: 0,
        phase: 0,
    };
}

function createBurnerAssembly(side, burnerMaterials) {
    const direction = side >= 0 ? 1 : -1;
    const group = new THREE.Group();
    group.position.set(direction * 36, -55, 24);
    const burnerShadowTexture = createSoftShadowTexture();
    const headRadius = 13.4;
    const bodyTopRadius = 13.0;
    const bodyBottomRadius = 12.2;
    const pilotOrbitRadius = NOZZLE_RING_MAJOR_RADIUS + 0.95;

    const addMesh = (
        geometry,
        material,
        position,
        {
            rotation = null,
            scale = null,
            order = 5,
            target = group,
        } = {}
    ) => {
        const mesh = new THREE.Mesh(geometry, material);
        if (position) {
            mesh.position.set(position[0], position[1], position[2]);
        }
        if (rotation) {
            mesh.rotation.set(rotation[0], rotation[1], rotation[2]);
        }
        if (scale) {
            mesh.scale.set(scale[0], scale[1], scale[2]);
        }
        mesh.renderOrder = order;
        target.add(mesh);
        return mesh;
    };

    const addPipeRun = (points, radius, material, order = 5) => {
        const pipeGroup = new THREE.Group();
        group.add(pipeGroup);
        for (let index = 0; index < points.length - 1; index += 1) {
            const start = new THREE.Vector3(...points[index]);
            const end = new THREE.Vector3(...points[index + 1]);
            const segment = end.clone().sub(start);
            const length = segment.length();
            if (length <= 0.001) continue;
            const pipe = new THREE.Mesh(
                new THREE.CylinderGeometry(radius, radius, length, 16),
                material
            );
            pipe.position.copy(start.clone().add(end).multiplyScalar(0.5));
            pipe.quaternion.setFromUnitVectors(
                new THREE.Vector3(0, 1, 0),
                segment.clone().normalize()
            );
            pipe.renderOrder = order;
            pipeGroup.add(pipe);
        }
        return pipeGroup;
    };

    const bodyShell = addMesh(
        new THREE.CylinderGeometry(bodyBottomRadius, bodyTopRadius, 80, 56),
        burnerMaterials.base,
        [0, -19.6, 0]
    );
    const burnerFace = addMesh(
        new THREE.CylinderGeometry(bodyTopRadius - 0.6, headRadius, 12.8, 56),
        burnerMaterials.face,
        [0, 29.4, 0]
    );
    const shoulderRing = addMesh(
        new THREE.CylinderGeometry(headRadius + 0.15, headRadius + 0.15, 1.5, 56),
        burnerMaterials.plate,
        [0, 21.6, 0]
    );
    const faceDish = addMesh(
        new THREE.CylinderGeometry(12.34, 9.34, 2.18, 56, 1, true),
        burnerMaterials.face,
        [0, 32.2, 0],
        { order: 7 }
    );
    const burnerCup = addMesh(
        new THREE.CylinderGeometry(8.74, 9.12, 0.72, 48),
        burnerMaterials.cup,
        [0, 30.9, 0],
        { order: 7 }
    );
    const recessWell = addMesh(
        new THREE.CylinderGeometry(6.08, 4.92, 3.2, 48, 1, true),
        burnerMaterials.plate,
        [0, 29.88, 0],
        { order: 8 }
    );
    const centerWell = addMesh(
        new THREE.CylinderGeometry(4.78, 4.92, 0.64, 40),
        burnerMaterials.face,
        [0, 28.42, 0],
        { order: 8 }
    );
    const centerThreadSleeve = addMesh(
        new THREE.CylinderGeometry(4.12, 4.12, 1.92, 40, 1, true),
        burnerMaterials.plate,
        [0, 29.28, 0],
        { order: 8 }
    );
    const centerThreadRingA = addMesh(
        new THREE.TorusGeometry(4.1, 0.08, 12, 42),
        burnerMaterials.plate,
        [0, 28.64, 0],
        { order: 8, rotation: [Math.PI * 0.5, 0, 0] }
    );
    const centerThreadRingB = addMesh(
        new THREE.TorusGeometry(4.1, 0.08, 12, 42),
        burnerMaterials.plate,
        [0, 29.12, 0],
        { order: 8, rotation: [Math.PI * 0.5, 0, 0] }
    );
    const centerThreadRingC = addMesh(
        new THREE.TorusGeometry(4.1, 0.08, 12, 42),
        burnerMaterials.plate,
        [0, 29.6, 0],
        { order: 8, rotation: [Math.PI * 0.5, 0, 0] }
    );
    const centerUpperCollar = addMesh(
        new THREE.CylinderGeometry(3.34, 3.54, 1.02, 36),
        burnerMaterials.face,
        [0, 30.32, 0],
        { order: 9 }
    );
    const centerDeck = addMesh(
        new THREE.CylinderGeometry(2.38, 2.48, 0.72, 28),
        burnerMaterials.ceramic,
        [0, 30.8, 0],
        { order: 9 }
    );
    const centerBoss = addMesh(
        new THREE.CylinderGeometry(2.64, 2.72, 0.26, 24),
        burnerMaterials.face,
        [0, 31.12, 0],
        { order: 9 }
    );

    const pedestal = addMesh(
        new THREE.CylinderGeometry(10.7, 12.05, 11.6, 48),
        burnerMaterials.base,
        [0, -65.6, 0]
    );
    const basePlate = addMesh(
        new THREE.CylinderGeometry(5.6, 9.8, 16.6, 44),
        burnerMaterials.base,
        [0, -79.6, 0]
    );
    const nozzleSleeve = addMesh(
        new THREE.CylinderGeometry(2.3, 4.9, 12.2, 32),
        burnerMaterials.nozzleCup,
        [0, -92.6, 0],
        { order: 6 }
    );
    const nozzleTip = addMesh(
        new THREE.CylinderGeometry(1.18, 2.55, 9.8, 24),
        burnerMaterials.face,
        [0, -103.4, 0],
        { order: 6 }
    );
    const nozzleGlass = addMesh(
        new THREE.CylinderGeometry(3.0, 0.92, 17.2, 24, 1, true),
        burnerMaterials.glass,
        [0, -103.9, 0],
        { order: 6 }
    );
    const tipNeedle = addMesh(
        new THREE.CylinderGeometry(0.36, 0.62, 6.2, 16),
        burnerMaterials.insert,
        [0, -111.3, 0],
        { order: 7 }
    );
    [0, 1, 2].forEach((index) => {
        const angle = (Math.PI * 2 * index) / 3;
        addMesh(
            new THREE.CylinderGeometry(0.16, 0.16, 12.4, 10),
            burnerMaterials.face,
            [Math.cos(angle) * 1.02, -103.8, Math.sin(angle) * 1.02],
            {
                order: 7,
                rotation: [Math.sin(angle) * 0.08, 0, Math.cos(angle) * -0.08],
            }
        );
    });
    const lowerHub = addMesh(
        new THREE.CylinderGeometry(6.0, 6.9, 6.8, 28),
        burnerMaterials.base,
        [0, -59.8, 0]
    );
    const upperClamp = addMesh(
        new THREE.CylinderGeometry(13.35, 13.35, 1.8, 42),
        burnerMaterials.plate,
        [0, -11.5, 0]
    );
    const lowerClamp = addMesh(
        new THREE.CylinderGeometry(11.2, 11.2, 1.9, 38),
        burnerMaterials.plate,
        [0, -58.4, 0]
    );

    const throat = addMesh(
        new THREE.CylinderGeometry(1.7, 1.9, 14.6, 18),
        burnerMaterials.pipe,
        [direction * 13.9, -50.1, 2.6],
        { rotation: [0, 0, Math.PI * 0.5] }
    );
    const inlet = addMesh(
        new THREE.CylinderGeometry(2.2, 2.4, 8.8, 18),
        burnerMaterials.pipe,
        [direction * 18.9, -50.1, 2.6],
        { rotation: [0, 0, Math.PI * 0.5] }
    );
    const inletStub = addMesh(
        new THREE.CylinderGeometry(1.2, 1.35, 11.8, 16),
        burnerMaterials.pipe,
        [direction * 16.8, -39.6, 6.7],
        { rotation: [0.78, 0, direction * 0.28] }
    );

    const pipeRunA = addPipeRun(
        [
            [direction * 12.1, -41.8, 5.8],
            [direction * 19.2, -41.8, 5.8],
            [direction * 23.0, -55.8, 5.8],
        ],
        1.08,
        burnerMaterials.pipe
    );
    const pipeRunB = addPipeRun(
        [
            [direction * 10.2, -55.8, 7.2],
            [direction * 16.3, -55.8, 7.2],
            [direction * 16.3, -70.8, 7.2],
        ],
        0.98,
        burnerMaterials.pipe
    );
    const pipeRunC = addPipeRun(
        [
            [direction * 10.6, -48.8, -5.4],
            [direction * 15.8, -48.8, -5.4],
            [direction * 18.2, -61.6, -5.4],
        ],
        0.92,
        burnerMaterials.pipe
    );
    const pipeRunD = addPipeRun(
        [
            [-direction * 8.8, -66.1, 4.8],
            [-direction * 14.6, -66.1, 4.8],
            [-direction * 14.6, -78.2, 4.8],
        ],
        0.9,
        burnerMaterials.pipe
    );

    const lowerPipeLeft = addMesh(
        new THREE.CylinderGeometry(0.94, 0.94, 18.5, 14),
        burnerMaterials.pipe,
        [-4.4, -93.5, 0.6]
    );
    const lowerPipeRight = addMesh(
        new THREE.CylinderGeometry(0.94, 0.94, 18.5, 14),
        burnerMaterials.pipe,
        [4.4, -93.5, 0.6]
    );
    const lowerPipeBrace = addMesh(
        new THREE.CylinderGeometry(0.78, 0.78, 9.6, 12),
        burnerMaterials.pipe,
        [0, -86.6, 0.6],
        { rotation: [0, 0, Math.PI * 0.5] }
    );
    const drainLeg = addMesh(
        new THREE.CylinderGeometry(1.1, 1.1, 12.8, 14),
        burnerMaterials.pipe,
        [direction * 10.2, -89.4, 6.8]
    );

    const nozzleCups = [];
    for (let nozzleIndex = 0; nozzleIndex < OUTER_NOZZLE_COUNT; nozzleIndex += 1) {
        const angle = (Math.PI * 2 * nozzleIndex) / OUTER_NOZZLE_COUNT;
        const x = Math.cos(angle) * pilotOrbitRadius;
        const z = Math.sin(angle) * pilotOrbitRadius;
        const cupGroup = new THREE.Group();
        cupGroup.position.set(x, 30.92, z);
        group.add(cupGroup);

        const sleeve = addMesh(
            new THREE.CylinderGeometry(1.08, 1.24, 0.28, 20),
            burnerMaterials.nozzleCup,
            [0, 0.08, 0],
            { order: 8, target: cupGroup }
        );
        const recess = addMesh(
            new THREE.CylinderGeometry(0.22, 0.94, 1.34, 20),
            burnerMaterials.insert,
            [0, -0.42, 0],
            { order: 9, target: cupGroup }
        );
        const cap = addMesh(
            new THREE.SphereGeometry(0.14, 10, 8),
            burnerMaterials.ceramic,
            [0, -0.72, 0],
            { order: 10, target: cupGroup }
        );
        const glow = addMesh(
            new THREE.SphereGeometry(0.16, 10, 8),
            new THREE.MeshBasicMaterial({
                color: 0x8bd2ff,
                transparent: true,
                opacity: 0.04,
                depthWrite: false,
                blending: THREE.AdditiveBlending,
                toneMapped: false,
            }),
            [0, -0.18, 0],
            { order: 10, target: cupGroup }
        );
        sleeve.renderOrder = 8;
        recess.renderOrder = 9;
        cap.renderOrder = 10;
        glow.renderOrder = 10;
        nozzleCups.push({
            sleeve,
            glow,
            recess,
            cap,
            baseGlowY: -0.18,
            angle,
        });
    }

    const corePorts = [];
    const corePortSpecs = [
        { x: 0, z: 0 },
        { x: -0.78, z: -0.78 },
        { x: 0, z: -0.78 },
        { x: 0.78, z: -0.78 },
        { x: -0.78, z: 0 },
        { x: 0.78, z: 0 },
        { x: -0.78, z: 0.78 },
        { x: 0, z: 0.78 },
        { x: 0.78, z: 0.78 },
    ];
    corePortSpecs.forEach((port, portIndex) => {
        const radius = Math.hypot(port.x, port.z);
        const angle = radius > 0 ? Math.atan2(port.z, port.x) : 0;
        const sleeve = addMesh(
            new THREE.CylinderGeometry(
                portIndex === 0 ? 0.28 : 0.24,
                portIndex === 0 ? 0.32 : 0.28,
                0.16,
                14
            ),
            burnerMaterials.face,
            [port.x, 30.98, port.z],
            { order: 10 }
        );
        const insert = addMesh(
            new THREE.CylinderGeometry(
                portIndex === 0 ? 0.1 : 0.08,
                portIndex === 0 ? 0.1 : 0.08,
                0.14,
                12
            ),
            burnerMaterials.insert,
            [port.x, 30.9, port.z],
            { order: 10 }
        );
        const glow = addMesh(
            new THREE.SphereGeometry(portIndex === 0 ? 0.12 : 0.09, 10, 8),
            new THREE.MeshBasicMaterial({
                color: 0x8bd2ff,
                transparent: true,
                opacity: portIndex === 0 ? 0.06 : 0.04,
                depthWrite: false,
                blending: THREE.AdditiveBlending,
                toneMapped: false,
            }),
            [port.x, 31.08, port.z],
            { order: 10 }
        );
        corePorts.push({
            sleeve,
            insert,
            glow,
            angle,
            radius,
            x: port.x,
            z: port.z,
            baseY: 31.08,
        });
    });

    const nozzleRing = addMesh(
        new THREE.TorusGeometry(NOZZLE_RING_MAJOR_RADIUS, NOZZLE_RING_TUBE_RADIUS, 16, 28),
        new THREE.MeshBasicMaterial({
            color: 0x92cfff,
            transparent: true,
            opacity: 0.09,
            depthWrite: false,
            blending: THREE.AdditiveBlending,
            toneMapped: false,
        }),
        [0, 31.28, 0],
        {
            rotation: [Math.PI * 0.5, 0, 0],
            order: 8,
        }
    );

    const burnerShadow = new THREE.Mesh(
        new THREE.PlaneGeometry(52, 42),
        new THREE.MeshBasicMaterial({
            color: 0x080605,
            map: burnerShadowTexture,
            transparent: true,
            opacity: 0.24,
            depthWrite: false,
            toneMapped: false,
        })
    );
    burnerShadow.rotation.x = -Math.PI * 0.5;
    burnerShadow.position.set(0, -59.8, 1.6);
    burnerShadow.renderOrder = 4;
    group.add(burnerShadow);

    const flameGroup = excludeFromFitBounds(new THREE.Group());
    group.add(flameGroup);

    const flameVolumeGeometry = new THREE.CylinderGeometry(0.01, FLAME_VOLUME_BASE_RADIUS, 1, 56, 52, true);
    flameVolumeGeometry.translate(0, 0.5, 0);
    const flameVolume = excludeFromFitBounds(new THREE.Mesh(
        flameVolumeGeometry,
        createFlameShaderMaterial(direction > 0 ? 0.73 : 0.21)
    ));
    flameGroup.add(flameVolume);

    const flameGlow = excludeFromFitBounds(new THREE.Mesh(
        new THREE.SphereGeometry(1, 20, 16),
        createFlameMaterial(0xffb86b, 0.14, THREE.AdditiveBlending)
    ));
    flameGroup.add(flameGlow);

    const flameCore = excludeFromFitBounds(new THREE.Mesh(
        new THREE.CylinderGeometry(0.01, FLAME_VOLUME_BASE_RADIUS * 0.48, 1, 28, 24, true),
        createFlameMaterial(0xfff5d9, 0.18, THREE.AdditiveBlending)
    ));
    flameGroup.add(flameCore);

    const innerCone = excludeFromFitBounds(new THREE.Mesh(
        new THREE.CylinderGeometry(0.01, FLAME_VOLUME_BASE_RADIUS * 0.3, 1, 24, 20, true),
        createFlameMaterial(0x8fd2ff, 0.16, THREE.AdditiveBlending)
    ));
    flameGroup.add(innerCone);

    const flameHalo = excludeFromFitBounds(new THREE.Mesh(
        new THREE.SphereGeometry(1, 24, 18),
        createFlameMaterial(0x8fd7ff, 0.08, THREE.AdditiveBlending)
    ));
    flameGroup.add(flameHalo);

    const heatShell = excludeFromFitBounds(new THREE.Mesh(
        new THREE.SphereGeometry(1, 24, 18),
        createFlameMaterial(0xffd39a, 0.05, THREE.AdditiveBlending)
    ));
    flameGroup.add(heatShell);

    const coreJetGroup = excludeFromFitBounds(new THREE.Group());
    flameGroup.add(coreJetGroup);
    const coreJets = [];
    const pilotJetGroup = excludeFromFitBounds(new THREE.Group());
    flameGroup.add(pilotJetGroup);
    const pilotJets = [];
    const coreShellGeometry = new THREE.CylinderGeometry(0.01, FLAME_VOLUME_BASE_RADIUS * 0.19, 1, 18, 18, true);
    coreShellGeometry.translate(0, 0.5, 0);
    const coreCoreGeometry = new THREE.CylinderGeometry(0.01, FLAME_VOLUME_BASE_RADIUS * 0.09, 1, 14, 14, true);
    coreCoreGeometry.translate(0, 0.5, 0);
    const pilotShellGeometry = new THREE.CylinderGeometry(0.01, FLAME_VOLUME_BASE_RADIUS * 0.24, 1, 18, 18, true);
    pilotShellGeometry.translate(0, 0.5, 0);
    const pilotCoreGeometry = new THREE.CylinderGeometry(0.01, FLAME_VOLUME_BASE_RADIUS * 0.12, 1, 14, 14, true);
    pilotCoreGeometry.translate(0, 0.5, 0);

    corePorts.forEach((port, portIndex) => {
        const jetGroup = excludeFromFitBounds(new THREE.Group());
        const shell = excludeFromFitBounds(new THREE.Mesh(
            coreShellGeometry,
            createFlameMaterial(portIndex === 0 ? 0xffc67b : 0xffac67, portIndex === 0 ? 0.16 : 0.13, THREE.AdditiveBlending)
        ));
        const core = excludeFromFitBounds(new THREE.Mesh(
            coreCoreGeometry,
            createFlameMaterial(0x92d8ff, portIndex === 0 ? 0.24 : 0.19, THREE.AdditiveBlending)
        ));
        const halo = excludeFromFitBounds(new THREE.Mesh(
            new THREE.SphereGeometry(portIndex === 0 ? 0.44 : 0.32, 14, 12),
            createFlameMaterial(0xffe0ae, portIndex === 0 ? 0.12 : 0.08, THREE.AdditiveBlending)
        ));
        const phaseOffset = portIndex * 0.61 + direction * 0.31;

        jetGroup.add(shell, core, halo);
        coreJetGroup.add(jetGroup);
        coreJets.push({
            group: jetGroup,
            shell,
            core,
            halo,
            angle: port.angle,
            radius: port.radius,
            x: port.x,
            z: port.z,
            phaseOffset,
            isCenter: port.radius < 0.1,
        });
    });

    for (let jetIndex = 0; jetIndex < OUTER_NOZZLE_COUNT; jetIndex += 1) {
        const jetGroup = excludeFromFitBounds(new THREE.Group());
        const shell = excludeFromFitBounds(new THREE.Mesh(
            pilotShellGeometry,
            createFlameMaterial(0xffaa63, 0.14, THREE.AdditiveBlending)
        ));
        const core = excludeFromFitBounds(new THREE.Mesh(
            pilotCoreGeometry,
            createFlameMaterial(0x89d4ff, 0.2, THREE.AdditiveBlending)
        ));
        const halo = excludeFromFitBounds(new THREE.Mesh(
            new THREE.SphereGeometry(0.34, 14, 12),
            createFlameMaterial(0xffd9a7, 0.09, THREE.AdditiveBlending)
        ));
        const phaseOffset = jetIndex * 0.73 + direction * 0.28;
        const angle = (Math.PI * 2 * jetIndex) / OUTER_NOZZLE_COUNT;

        jetGroup.add(shell, core, halo);
        pilotJetGroup.add(jetGroup);
        pilotJets.push({
            group: jetGroup,
            shell,
            core,
            halo,
            angle,
            phaseOffset,
        });
    }

    const cadRoot = new THREE.Group();
    cadRoot.name = "burner-cad-root";
    group.add(cadRoot);

    const proceduralMetalNodes = [
        burnerFace,
        shoulderRing,
        faceDish,
        burnerCup,
        recessWell,
        centerWell,
        centerThreadSleeve,
        centerThreadRingA,
        centerThreadRingB,
        centerThreadRingC,
        centerUpperCollar,
        centerDeck,
        centerBoss,
        upperClamp,
        lowerClamp,
        lowerHub,
        nozzleSleeve,
        nozzleTip,
        nozzleGlass,
        tipNeedle,
        throat,
        inlet,
        inletStub,
        lowerPipeLeft,
        lowerPipeRight,
        lowerPipeBrace,
        drainLeg,
        pipeRunA,
        pipeRunB,
        pipeRunC,
        pipeRunD,
    ];

    loadBurnerCadTemplate()
        .then((template) => {
            const cadModel = template.clone(true);
            cadModel.position.y += BURNER_CAD_MOUNT_FACE_Y;
            cadRoot.add(cadModel);
            globalThis.__burnerCadMounted = (globalThis.__burnerCadMounted || 0) + 1;
            globalThis.__burnerCadNodes = globalThis.__burnerCadNodes || {};
            globalThis.__burnerCadNodes[side >= 0 ? "right" : "left"] = cadModel;
            cadModel.updateMatrixWorld(true);
            const debugBox = new THREE.Box3().setFromObject(cadModel);
            globalThis.__burnerCadLastMount = {
                count: globalThis.__burnerCadMounted,
                side: side >= 0 ? "right" : "left",
                min: { x: debugBox.min.x, y: debugBox.min.y, z: debugBox.min.z },
                max: { x: debugBox.max.x, y: debugBox.max.y, z: debugBox.max.z },
            };
            proceduralMetalNodes.forEach((node) => {
                if (node) node.visible = false;
            });
            nozzleCups.forEach((entry) => {
                entry.sleeve.visible = false;
                entry.recess.visible = false;
                if (entry.cap) entry.cap.visible = false;
                entry.glow.visible = false;
            });
            corePorts.forEach((entry) => {
                entry.sleeve.visible = false;
                entry.insert.visible = false;
                entry.glow.visible = false;
            });
        })
        .catch((error) => {
            console.warn("[kiln-scene] burner CAD load failed", error);
        });

    corePorts.forEach((entry) => {
        entry.sleeve.renderOrder = 9;
        entry.glow.renderOrder = 10;
    });
    heatShell.renderOrder = 8;
    flameHalo.renderOrder = 8;
    flameGlow.renderOrder = 9;
    innerCone.renderOrder = 10;
    flameCore.renderOrder = 10;
    flameVolume.renderOrder = 10;
    coreJets.forEach((entry) => {
        entry.halo.renderOrder = 10;
        entry.shell.renderOrder = 11;
        entry.core.renderOrder = 12;
    });
    pilotJets.forEach((entry) => {
        entry.halo.renderOrder = 10;
        entry.shell.renderOrder = 11;
        entry.core.renderOrder = 12;
    });

    return {
        group,
        throat,
        burnerCup,
        basePlate,
        pedestal,
        burnerShadow,
        nozzleRing,
        flameVolume,
        flameGlow,
        flameCore,
        innerCone,
        flameHalo,
        heatShell,
        burnerFace,
        recessWell,
        nozzleCups,
        corePorts,
        coreJets,
        pilotJets,
        pilotOrbitRadius,
        cadRoot,
    };
}

function createRadiationArrowUnit(color) {
    const group = new THREE.Group();
    const shaft = new THREE.Mesh(
        new THREE.BoxGeometry(13, 2.1, 2.1),
        new THREE.MeshBasicMaterial({
            color,
            transparent: true,
            opacity: 0.72,
            depthWrite: false,
            blending: THREE.AdditiveBlending,
            toneMapped: false,
        })
    );
    const headGeometry = new THREE.ConeGeometry(3.5, 7.5, 18);
    headGeometry.rotateZ(-Math.PI * 0.5);
    const head = new THREE.Mesh(headGeometry, shaft.material.clone());
    head.position.x = 9.2;
    shaft.renderOrder = 1;
    head.renderOrder = 1;
    group.add(shaft, head);
    return { group, shaft, head };
}

function createRadiationArrowLayer(sceneRoot) {
    const group = new THREE.Group();
    group.name = "kiln-radiation-arrows";
    sceneRoot.add(group);

    const rows = [];
    const rowCount = Math.max(...Object.values(PRODUCT_LAYOUTS).map((layout) => layout.arrowRows.length));
    for (let index = 0; index < rowCount; index += 1) {
        const row = new THREE.Group();
        const leftTrack = new THREE.Group();
        const rightTrack = new THREE.Group();
        const leftUnits = Array.from({ length: 3 }, () => createRadiationArrowUnit(0x5aafff));
        const rightUnits = Array.from({ length: 3 }, () => createRadiationArrowUnit(0x5aafff));
        leftUnits.forEach((unit) => leftTrack.add(unit.group));
        rightUnits.forEach((unit) => rightTrack.add(unit.group));
        row.add(leftTrack, rightTrack);
        group.add(row);
        rows.push({ row, leftTrack, rightTrack, leftUnits, rightUnits });
    }

    assignFocusGroup(group, "radiation");
    return { group, rows };
}

function createRearBrickGrid(width, height, material) {
    const group = new THREE.Group();
    const usableHeight = height - 8;
    const rowCount = 8;
    const rowGap = usableHeight / rowCount;

    for (let row = 0; row < rowCount; row += 1) {
        const y = 6 + row * rowGap;
        const line = new THREE.Mesh(
            new THREE.BoxGeometry(width - 12, 0.8, 0.8),
            material
        );
        line.position.set(0, y, 0);
        group.add(line);
    }

    for (let row = 0; row < rowCount - 1; row += 1) {
        const offset = row % 2 === 0 ? 0 : 8;
        for (let column = -4; column <= 4; column += 1) {
            const bar = new THREE.Mesh(
                new THREE.BoxGeometry(0.8, rowGap - 1.4, 0.8),
                material
            );
            bar.position.set(column * 16 + offset, 9 + row * rowGap + rowGap * 0.5, 0);
            group.add(bar);
        }
    }

    return group;
}

function createKilnStructure(sceneRoot) {
    const kilnGroup = new THREE.Group();
    kilnGroup.name = "kiln-structure";
    sceneRoot.add(kilnGroup);
    const ceramicDetailTexture = createCeramicDetailTexture();
    const stoneDetailTexture = createStoneDetailTexture();
    const metalDetailTexture = createMetalDetailTexture();
    const brickColorTexture = createBrickColorTexture();
    const brickReliefTexture = createBrickReliefTexture();
    const baseShadowTexture = createSoftShadowTexture();

    const capMaterial = new THREE.MeshBasicMaterial({
        transparent: true,
        opacity: 0,
        depthWrite: false,
        side: THREE.DoubleSide,
    });

    const shellMaterial = new THREE.MeshPhysicalMaterial({
        color: 0xb97a49,
        map: brickColorTexture,
        roughness: 0.86,
        roughnessMap: brickReliefTexture,
        metalness: 0.02,
        transmission: 0.02,
        transparent: true,
        opacity: 0.22,
        thickness: 0.18,
        ior: 1.12,
        emissive: 0x25140d,
        emissiveIntensity: 0.08,
        bumpMap: brickReliefTexture,
        bumpScale: 0.34,
        clearcoat: 0.08,
        clearcoatRoughness: 0.88,
        envMapIntensity: 0.22,
        depthWrite: false,
        side: THREE.DoubleSide,
    });
    const shellFaceMaterial = shellMaterial.clone();
    shellFaceMaterial.roughness = 0.72;
    shellFaceMaterial.opacity = 0.28;
    shellFaceMaterial.clearcoat = 0.04;

    const chamberMaterial = new THREE.MeshPhysicalMaterial({
        color: 0xa55f33,
        map: brickColorTexture,
        roughness: 0.92,
        roughnessMap: brickReliefTexture,
        metalness: 0.02,
        transmission: 0.01,
        transparent: true,
        opacity: 0.38,
        thickness: 0.32,
        emissive: 0x3b2012,
        emissiveIntensity: 0.16,
        bumpMap: brickReliefTexture,
        bumpScale: 0.56,
        clearcoat: 0.04,
        clearcoatRoughness: 0.92,
        envMapIntensity: 0.16,
        depthWrite: false,
        side: THREE.DoubleSide,
    });
    const chamberFaceMaterial = chamberMaterial.clone();
    chamberFaceMaterial.roughness = 0.84;
    chamberFaceMaterial.opacity = 0.46;

    const frameMaterial = new THREE.MeshPhysicalMaterial({
        color: 0x73807b,
        roughness: 0.36,
        roughnessMap: metalDetailTexture,
        metalness: 0.78,
        emissive: 0x0f1f2f,
        emissiveIntensity: 0.08,
        clearcoat: 0.12,
        clearcoatRoughness: 0.56,
        envMapIntensity: 1.08,
    });
    const frameDarkMaterial = frameMaterial.clone();
    frameDarkMaterial.color = new THREE.Color(0x35383e);
    frameDarkMaterial.roughness = 0.52;
    frameDarkMaterial.metalness = 0.7;

    const rackMaterial = new THREE.MeshPhysicalMaterial({
        color: 0xb39c82,
        roughness: 0.86,
        roughnessMap: stoneDetailTexture,
        metalness: 0.04,
        bumpMap: stoneDetailTexture,
        bumpScale: 0.28,
        emissive: 0x241d19,
        emissiveIntensity: 0.06,
        clearcoat: 0.22,
        clearcoatRoughness: 0.74,
        envMapIntensity: 0.34,
    });

    const basePlatform = new THREE.Mesh(
        new THREE.BoxGeometry(176, 9, 74),
        new THREE.MeshPhysicalMaterial({
            color: 0x4b4743,
            roughness: 0.94,
            roughnessMap: stoneDetailTexture,
            metalness: 0.04,
            bumpMap: stoneDetailTexture,
            bumpScale: 0.52,
            clearcoat: 0.08,
            clearcoatRoughness: 0.9,
            envMapIntensity: 0.22,
        })
    );
    basePlatform.position.set(0, -67, 0);
    kilnGroup.add(basePlatform);

    const baseShadow = new THREE.Mesh(
        new THREE.PlaneGeometry(154, 62),
        new THREE.MeshBasicMaterial({
            color: 0x090605,
            map: baseShadowTexture,
            transparent: true,
            opacity: 0.26,
            depthWrite: false,
            toneMapped: false,
        })
    );
    baseShadow.rotation.x = -Math.PI * 0.5;
    baseShadow.position.set(0, -62.38, 3);
    kilnGroup.add(baseShadow);

    const halo = new THREE.Group();
    const haloRing = new THREE.Mesh(
        new THREE.TorusGeometry(66, 2.8, 18, 96),
        new THREE.MeshBasicMaterial({
            color: 0xffb175,
            transparent: true,
            opacity: 0.018,
            depthWrite: false,
            blending: THREE.AdditiveBlending,
            toneMapped: false,
        })
    );
    haloRing.rotation.x = Math.PI * 0.5;
    haloRing.position.y = -59;
    halo.add(haloRing);

    const haloDisc = new THREE.Mesh(
        new THREE.CircleGeometry(72, 56),
        new THREE.MeshBasicMaterial({
            color: 0xff8d54,
            transparent: true,
            opacity: 0.01,
            depthWrite: false,
            blending: THREE.AdditiveBlending,
            toneMapped: false,
        })
    );
    haloDisc.rotation.x = -Math.PI * 0.5;
    haloDisc.position.y = -58.4;
    halo.add(haloDisc);
    kilnGroup.add(halo);

    const shellBody = new THREE.Mesh(
        createArchExtrudeGeometry(
            KILN_DIMENSIONS.shellWidth,
            KILN_DIMENSIONS.shellShoulderY,
            KILN_DIMENSIONS.shellDepth
        ),
        [capMaterial.clone(), shellMaterial]
    );
    shellBody.position.y = KILN_DIMENSIONS.shellBaseY;
    kilnGroup.add(shellBody);
    const shellBodyEdge = createTechEdge(shellBody.geometry, 0x82dcff, 0.24);
    shellBodyEdge.position.copy(shellBody.position);
    kilnGroup.add(shellBodyEdge);

    const shellFront = new THREE.Mesh(
        createArchRingGeometry(
            KILN_DIMENSIONS.shellWidth,
            KILN_DIMENSIONS.shellShoulderY,
            KILN_DIMENSIONS.chamberWidth + 18,
            KILN_DIMENSIONS.chamberShoulderY + 3,
            6
        ),
        shellFaceMaterial
    );
    shellFront.position.set(0, KILN_DIMENSIONS.shellBaseY, KILN_DIMENSIONS.frontZ);
    shellFront.visible = false;
    kilnGroup.add(shellFront);
    const shellFrontEdge = createTechEdge(shellFront.geometry, 0xbaf0ff, 0.42);
    shellFrontEdge.position.copy(shellFront.position);
    shellFrontEdge.visible = false;
    kilnGroup.add(shellFrontEdge);

    const shellInnerBandMaterial = frameDarkMaterial.clone();
    shellInnerBandMaterial.transparent = true;
    shellInnerBandMaterial.opacity = 0.14;
    const shellInnerBand = new THREE.Mesh(
        createArchRingGeometry(
            KILN_DIMENSIONS.shellWidth - 16,
            KILN_DIMENSIONS.shellShoulderY - 10,
            KILN_DIMENSIONS.chamberWidth + 2,
            KILN_DIMENSIONS.chamberShoulderY - 4,
            2.2
        ),
        shellInnerBandMaterial
    );
    shellInnerBand.position.set(0, KILN_DIMENSIONS.shellBaseY + 2, KILN_DIMENSIONS.frontZ - 4.5);
    kilnGroup.add(shellInnerBand);

    const shellBack = new THREE.Mesh(
        createArchPanelGeometry(KILN_DIMENSIONS.shellWidth, KILN_DIMENSIONS.shellShoulderY),
        new THREE.MeshStandardMaterial({
            color: 0xbb7442,
            map: brickColorTexture,
            roughness: 0.9,
            roughnessMap: brickReliefTexture,
            metalness: 0.01,
            bumpMap: brickReliefTexture,
            bumpScale: 0.46,
            emissive: 0x2a150c,
            emissiveIntensity: 0.07,
            side: THREE.DoubleSide,
        })
    );
    shellBack.position.set(0, KILN_DIMENSIONS.shellBaseY, -KILN_DIMENSIONS.shellDepth * 0.5 + 0.6);
    kilnGroup.add(shellBack);

    const chamber = new THREE.Mesh(
        createArchExtrudeGeometry(
            KILN_DIMENSIONS.chamberWidth,
            KILN_DIMENSIONS.chamberShoulderY,
            KILN_DIMENSIONS.chamberDepth
        ),
        [capMaterial.clone(), chamberMaterial]
    );
    chamber.position.y = KILN_DIMENSIONS.chamberBaseY;
    kilnGroup.add(chamber);
    const chamberEdge = createTechEdge(chamber.geometry, 0xffb26d, 0.18);
    chamberEdge.position.copy(chamber.position);
    kilnGroup.add(chamberEdge);

    const chamberReveal = new THREE.Mesh(
        createArchRingGeometry(
            KILN_DIMENSIONS.chamberWidth + 6,
            KILN_DIMENSIONS.chamberShoulderY + 1,
            KILN_DIMENSIONS.chamberWidth - 4,
            KILN_DIMENSIONS.chamberShoulderY - 1.5,
            4
        ),
        chamberFaceMaterial
    );
    chamberReveal.position.set(0, KILN_DIMENSIONS.chamberBaseY, 21);
    kilnGroup.add(chamberReveal);
    const chamberRevealEdge = createTechEdge(chamberReveal.geometry, 0xffcb9d, 0.22);
    chamberRevealEdge.position.copy(chamberReveal.position);
    kilnGroup.add(chamberRevealEdge);

    const chamberBack = new THREE.Mesh(
        createArchPanelGeometry(KILN_DIMENSIONS.chamberWidth - 6, KILN_DIMENSIONS.chamberShoulderY - 0.4),
        new THREE.MeshStandardMaterial({
            color: 0xc4763d,
            map: brickColorTexture,
            roughness: 0.96,
            roughnessMap: brickReliefTexture,
            metalness: 0.02,
            bumpMap: brickReliefTexture,
            bumpScale: 0.72,
            emissive: 0x472415,
            emissiveIntensity: 0.12,
            side: THREE.DoubleSide,
        })
    );
    chamberBack.position.set(0, KILN_DIMENSIONS.chamberBaseY + 1.4, -KILN_DIMENSIONS.chamberDepth * 0.5 + 0.9);
    kilnGroup.add(chamberBack);

    const brickGrid = createRearBrickGrid(
        KILN_DIMENSIONS.chamberWidth - 12,
        archHeight(KILN_DIMENSIONS.chamberWidth - 6, KILN_DIMENSIONS.chamberShoulderY - 0.4),
        new THREE.MeshBasicMaterial({
            color: 0xe0b287,
            transparent: true,
            opacity: 0.22,
            depthWrite: false,
        })
    );
    brickGrid.position.set(0, KILN_DIMENSIONS.chamberBaseY + 1.6, -KILN_DIMENSIONS.chamberDepth * 0.5 + 1.4);
    kilnGroup.add(brickGrid);

    const floorPlate = new THREE.Mesh(
        new THREE.BoxGeometry(102, 4, 28),
        new THREE.MeshStandardMaterial({
            color: 0x8f5b35,
            map: brickColorTexture,
            roughness: 0.88,
            roughnessMap: brickReliefTexture,
            metalness: 0.04,
            bumpMap: brickReliefTexture,
            bumpScale: 0.34,
            emissive: 0x30170e,
            emissiveIntensity: 0.14,
        })
    );
    floorPlate.position.set(0, KILN_DIMENSIONS.floorY, 0);
    kilnGroup.add(floorPlate);

    const threshold = new THREE.Mesh(
        new THREE.BoxGeometry(94, 4, 4.4),
        frameDarkMaterial
    );
    threshold.position.set(0, KILN_DIMENSIONS.floorY + 2, KILN_DIMENSIONS.frontZ - 2);
    kilnGroup.add(threshold);

    const heatVeil = new THREE.Mesh(
        new THREE.PlaneGeometry(76, 86),
        new THREE.MeshBasicMaterial({
            color: 0x68c8ff,
            transparent: true,
            opacity: 0.03,
            depthWrite: false,
            side: THREE.DoubleSide,
            blending: THREE.AdditiveBlending,
            toneMapped: false,
        })
    );
    heatVeil.position.set(0, 2, -2);
    kilnGroup.add(heatVeil);

    const doorFrame = new THREE.Mesh(
        createArchRingGeometry(
            KILN_DIMENSIONS.chamberWidth + 14,
            KILN_DIMENSIONS.chamberShoulderY - 1.5,
            KILN_DIMENSIONS.chamberWidth - 2,
            KILN_DIMENSIONS.chamberShoulderY - 7.4,
            2.8
        ),
        frameMaterial
    );
    doorFrame.position.set(0, KILN_DIMENSIONS.shellBaseY + 1.8, KILN_DIMENSIONS.frontZ + 1.4);
    kilnGroup.add(doorFrame);
    const doorFrameEdge = createTechEdge(doorFrame.geometry, 0xc7f2ff, 0.34);
    doorFrameEdge.position.copy(doorFrame.position);
    kilnGroup.add(doorFrameEdge);

    const door = new THREE.Mesh(
        createArchRingGeometry(
            KILN_DIMENSIONS.chamberWidth + 6,
            KILN_DIMENSIONS.chamberShoulderY - 5,
            KILN_DIMENSIONS.chamberWidth - 2,
            KILN_DIMENSIONS.chamberShoulderY - 7.2,
            2
        ),
        frameDarkMaterial
    );
    door.position.set(0, KILN_DIMENSIONS.chamberBaseY + 1.4, KILN_DIMENSIONS.frontZ - 0.2);
    kilnGroup.add(door);

    const doorPivot = new THREE.Group();
    const hingeLeft = new THREE.Mesh(
        new THREE.BoxGeometry(4.2, 18, 4.2),
        frameDarkMaterial
    );
    hingeLeft.position.set(-66, -10, KILN_DIMENSIONS.frontZ + 2);
    const hingeRight = hingeLeft.clone();
    hingeRight.position.x = 66;
    doorPivot.add(hingeLeft, hingeRight);
    kilnGroup.add(doorPivot);

    const shellApexY = KILN_DIMENSIONS.shellBaseY + archHeight(KILN_DIMENSIONS.shellWidth, KILN_DIMENSIONS.shellShoulderY);
    const smokeStack = new THREE.Group();
    const stackBase = new THREE.Mesh(
        new THREE.BoxGeometry(20, 8, 14),
        frameDarkMaterial
    );
    smokeStack.add(stackBase);

    const smokeNeck = new THREE.Mesh(
        new THREE.CylinderGeometry(8.5, 9.2, 24, 22, 1, true),
        new THREE.MeshStandardMaterial({
            color: 0x4d6f58,
            roughness: 0.48,
            metalness: 0.22,
            emissive: 0x11271d,
            emissiveIntensity: 0.08,
            side: THREE.DoubleSide,
        })
    );
    smokeNeck.position.y = 18;
    smokeStack.add(smokeNeck);

    const smokeCapMaterial = frameMaterial.clone();
    smokeCapMaterial.side = THREE.DoubleSide;
    const smokeCap = new THREE.Mesh(
        new THREE.CylinderGeometry(12.2, 12.8, 4, 24, 1, true),
        smokeCapMaterial
    );
    smokeCap.position.y = 32;
    smokeStack.add(smokeCap);

    const smokeLip = new THREE.Mesh(
        new THREE.TorusGeometry(12.1, 0.8, 16, 28),
        frameMaterial.clone()
    );
    smokeLip.rotation.x = Math.PI * 0.5;
    smokeLip.position.y = 34;
    smokeStack.add(smokeLip);
    smokeStack.position.set(0, shellApexY + 4, -2.5);
    kilnGroup.add(smokeStack);

    const rack = new THREE.Group();
    const postGeometry = new THREE.BoxGeometry(2.4, 108, 2.4);
    [-38, 38].forEach((x) => {
        [-8, 8].forEach((z) => {
            const post = new THREE.Mesh(postGeometry, rackMaterial);
            post.position.set(x, -4, z);
            rack.add(post);
        });
    });

    const shelfLevels = SHELF_LEVELS;
    const shelves = shelfLevels.map((y, index) => {
        const slab = new THREE.Mesh(
            new THREE.BoxGeometry(KILN_DIMENSIONS.rackWidth, 2.2, KILN_DIMENSIONS.rackDepth),
            rackMaterial.clone()
        );
        slab.position.set(0, y, 0);
        rack.add(slab);

        const lip = new THREE.Mesh(
            new THREE.BoxGeometry(KILN_DIMENSIONS.rackWidth - 8, 1.1, 2),
            frameDarkMaterial
        );
        lip.position.set(0, y + 0.8, 9.6);
        rack.add(lip);

        const brace = new THREE.Mesh(
            new THREE.BoxGeometry(76 - index * 4, 1.1, 2),
            frameDarkMaterial
        );
        brace.position.set(0, y + 0.8, -9.6);
        rack.add(brace);

        return {
            slab,
            lip,
            brace,
        };
    });
    kilnGroup.add(rack);

    const burnerMaterials = {
        plate: new THREE.MeshPhysicalMaterial({
            color: 0x6f6d6a,
            roughness: 0.24,
            roughnessMap: metalDetailTexture,
            metalness: 0.96,
            bumpMap: metalDetailTexture,
            bumpScale: 0.03,
            clearcoat: 0.68,
            clearcoatRoughness: 0.12,
            envMapIntensity: 1.02,
        }),
        base: new THREE.MeshPhysicalMaterial({
            color: 0xd2d0cd,
            roughness: 0.16,
            roughnessMap: metalDetailTexture,
            metalness: 0.95,
            bumpMap: metalDetailTexture,
            bumpScale: 0.025,
            clearcoat: 0.86,
            clearcoatRoughness: 0.06,
            envMapIntensity: 1.22,
        }),
        cup: new THREE.MeshPhysicalMaterial({
            color: 0xbc8a6d,
            roughness: 0.22,
            roughnessMap: metalDetailTexture,
            metalness: 0.74,
            bumpMap: metalDetailTexture,
            bumpScale: 0.02,
            clearcoat: 0.72,
            clearcoatRoughness: 0.12,
            ior: 1.47,
            envMapIntensity: 1.08,
        }),
        face: new THREE.MeshPhysicalMaterial({
            color: 0xcfd0d0,
            roughness: 0.14,
            roughnessMap: metalDetailTexture,
            metalness: 0.97,
            bumpMap: metalDetailTexture,
            bumpScale: 0.02,
            clearcoat: 0.9,
            clearcoatRoughness: 0.06,
            envMapIntensity: 1.22,
        }),
        nozzleCup: new THREE.MeshPhysicalMaterial({
            color: 0xab7a60,
            roughness: 0.26,
            roughnessMap: metalDetailTexture,
            metalness: 0.68,
            bumpMap: metalDetailTexture,
            bumpScale: 0.03,
            clearcoat: 0.48,
            clearcoatRoughness: 0.16,
            envMapIntensity: 1.04,
        }),
        insert: new THREE.MeshPhysicalMaterial({
            color: 0x34160e,
            roughness: 0.34,
            roughnessMap: metalDetailTexture,
            metalness: 0.48,
            bumpMap: metalDetailTexture,
            bumpScale: 0.02,
            clearcoat: 0.22,
            clearcoatRoughness: 0.18,
            envMapIntensity: 0.9,
        }),
        ceramic: new THREE.MeshPhysicalMaterial({
            color: 0xb8a15d,
            roughness: 0.38,
            metalness: 0.06,
            clearcoat: 0.16,
            clearcoatRoughness: 0.3,
            envMapIntensity: 0.68,
        }),
        pipe: new THREE.MeshPhysicalMaterial({
            color: 0xd0d4d8,
            roughness: 0.18,
            roughnessMap: metalDetailTexture,
            metalness: 0.95,
            bumpMap: metalDetailTexture,
            bumpScale: 0.03,
            clearcoat: 0.68,
            clearcoatRoughness: 0.1,
            envMapIntensity: 1.1,
        }),
        glass: new THREE.MeshPhysicalMaterial({
            color: 0xf5f7fa,
            roughness: 0.04,
            metalness: 0,
            transparent: true,
            opacity: 0.24,
            transmission: 0.84,
            thickness: 0.7,
            ior: 1.36,
            envMapIntensity: 1.14,
            side: THREE.DoubleSide,
        }),
    };

    const burners = [-1, 1].map((side) => createBurnerAssembly(side, burnerMaterials));
    burners.forEach((entry) => kilnGroup.add(entry.group));

    const arrowLayer = createRadiationArrowLayer(kilnGroup);

    assignFocusGroup(kilnGroup, "structure");

    return {
        group: kilnGroup,
        baseShadow,
        halo,
        haloRing,
        haloDisc,
        shellBody,
        shellBodyEdge,
        shellFront,
        shellFrontEdge,
        shellInnerBand,
        shellBack,
        chamber,
        chamberEdge,
        chamberBack,
        chamberReveal,
        chamberRevealEdge,
        doorPivot,
        door,
        doorFrame,
        doorFrameEdge,
        smokeStack,
        smokeNeck,
        smokeCap,
        smokeLip,
        shelves,
        rack,
        heatVeil,
        burners,
        arrowLayer,
        materials: {
            shell: shellMaterial,
            shellFace: shellFaceMaterial,
            chamber: chamberMaterial,
            chamberFace: chamberFaceMaterial,
            frame: frameMaterial,
            frameDark: frameDarkMaterial,
            rack: rackMaterial,
            burnerPlate: burnerMaterials.plate,
            burnerCup: burnerMaterials.cup,
            burnerBase: burnerMaterials.base,
            burnerPipe: burnerMaterials.pipe,
            burnerFace: burnerMaterials.face,
            burnerNozzleCup: burnerMaterials.nozzleCup,
            burnerInsert: burnerMaterials.insert,
            burnerCeramic: burnerMaterials.ceramic,
        },
    };
}

function createProductLayer(sceneRoot) {
    const group = new THREE.Group();
    group.name = "kiln-products";
    sceneRoot.add(group);
    const ceramicDetailTexture = createCeramicDetailTexture();
    const productShadowTexture = createSoftShadowTexture();

    const geometries = {
        large: createLargeProductGeometry(),
        small: createSmallProductGeometry(),
    };
    const geometryBounds = Object.fromEntries(
        Object.entries(geometries).map(([key, geometry]) => {
            geometry.computeBoundingBox();
            return [key, {
                minY: geometry.boundingBox?.min.y ?? 0,
                maxY: geometry.boundingBox?.max.y ?? 0,
            }];
        })
    );
    const productMaterial = new THREE.MeshPhysicalMaterial({
        color: 0xdfe6d7,
        roughness: 0.34,
        roughnessMap: ceramicDetailTexture,
        metalness: 0.01,
        transmission: 0.02,
        thickness: 0.22,
        ior: 1.46,
        bumpMap: ceramicDetailTexture,
        bumpScale: 0.06,
        emissive: 0x17110d,
        emissiveIntensity: 0.026,
        clearcoat: 0.94,
        clearcoatRoughness: 0.16,
        sheen: 0.22,
        envMapIntensity: 1.18,
    });

    const rimMaterial = new THREE.MeshPhysicalMaterial({
        color: 0xe8e1d4,
        roughness: 0.22,
        metalness: 0,
        transmission: 0.01,
        thickness: 0.08,
        clearcoat: 0.94,
        clearcoatRoughness: 0.12,
        envMapIntensity: 0.92,
    });

    const footMaterial = new THREE.MeshStandardMaterial({
        color: 0xb48762,
        roughness: 0.84,
        roughnessMap: ceramicDetailTexture,
        bumpMap: ceramicDetailTexture,
        bumpScale: 0.05,
        metalness: 0.02,
        emissive: 0x17100b,
        emissiveIntensity: 0.01,
    });

    function createEntry(type) {
        const shadow = new THREE.Mesh(
            new THREE.PlaneGeometry(1, 1),
            new THREE.MeshBasicMaterial({
                color: 0x120a08,
                map: productShadowTexture,
                transparent: true,
                opacity: 0.16,
                depthWrite: false,
                toneMapped: false,
            })
        );
        shadow.rotation.x = -Math.PI * 0.5;
        const shell = new THREE.Mesh(geometries[type], productMaterial.clone());
        const rim = new THREE.Mesh(
            new THREE.TorusGeometry(type === "large" ? 1.28 : 0.98, type === "large" ? 0.16 : 0.12, 18, 40),
            rimMaterial.clone()
        );
        rim.rotation.x = Math.PI * 0.5;
        const foot = new THREE.Mesh(
            new THREE.TorusGeometry(type === "large" ? 1.52 : 1.12, type === "large" ? 0.14 : 0.11, 16, 36),
            footMaterial.clone()
        );
        foot.rotation.x = Math.PI * 0.5;
        shadow.renderOrder = 4;
        shell.renderOrder = 6;
        rim.renderOrder = 7;
        foot.renderOrder = 7;
        shadow.visible = false;
        shell.visible = false;
        rim.visible = false;
        foot.visible = false;
        group.add(shadow, shell, rim, foot);
        return { shadow, shell, rim, foot, type };
    }

    const sets = {
        large: Array.from({ length: PRODUCT_POOL_LIMITS.large }, () => createEntry("large")),
        small: Array.from({ length: PRODUCT_POOL_LIMITS.small }, () => createEntry("small")),
    };
    const displayState = {
        layoutKey: null,
        currentAssignments: [],
        transition: null,
    };

    assignFocusGroup(group, "products");

    function hideAll() {
        Object.values(sets).forEach((entries) => {
            entries.forEach(({ shadow, shell, rim, foot }) => {
                shadow.visible = false;
                shell.visible = false;
                rim.visible = false;
                foot.visible = false;
            });
        });
    }

    function buildAssignments(state, layout, time) {
        const visualType = layout.productType === "large" ? "large" : "small";
        const bounds = geometryBounds[visualType];
        const entries = sets[visualType];
        const baseScale = computeProductScale(
            state.temperature,
            visualType,
            state.productSpec?.sizeFactor ?? state.productSpec?.sizeRatio ?? 1
        );

        return layout.slots.slice(0, entries.length).map((slot, index) => {
            const bob = Math.sin((time || 0) * 0.8 + index * 0.7) * 0.04;
            const twist = (index % 2 === 0 ? -1 : 1) * 0.024;
            const scale = slot.scale * baseScale * (1 + bob * 0.03);
            const shelfY = SHELF_LEVELS[slot.shelfIndex] ?? 0;
            const surfaceY = shelfY + 1.12;
            const baseLift = -bounds.minY * scale;
            return {
                entry: entries[index],
                type: visualType,
                index,
                position: {
                    x: slot.x,
                    y: surfaceY + baseLift + bob,
                    z: slot.z,
                },
                surfaceY,
                rotationY: twist,
                scale,
            };
        });
    }

    function applyAssignment(assignment, state, alpha, scaleMultiplier = 1, viewState = {}) {
        const { palette } = state;
        const { entry, type, position, surfaceY, rotationY, scale } = assignment;
        if (!entry) return;
        const sideReveal = clamp(viewState.sideReveal ?? 0, 0, 1);
        const bounds = geometryBounds[type];
        entry.shadow.visible = alpha > 0.001;
        entry.shell.visible = alpha > 0.001;
        entry.rim.visible = alpha > 0.001;
        entry.foot.visible = alpha > 0.001;
        if (!entry.shell.visible) return;

        const scaledSize = scale * scaleMultiplier;
        const shadowWidth = (type === "large" ? 8.8 : 6.2) * scaledSize;
        const shadowDepth = shadowWidth * (type === "large" ? 0.84 : 0.8);
        entry.shadow.position.set(position.x, surfaceY + 0.04, position.z);
        entry.shadow.scale.set(shadowWidth, shadowDepth, 1);
        entry.shadow.material.opacity = alpha * (0.11 + state.heat * 0.09);
        entry.shell.position.set(position.x, position.y, position.z);
        entry.shell.rotation.set(0, rotationY, 0);
        entry.shell.scale.setScalar(scaledSize);
        entry.rim.position.set(
            position.x,
            position.y + bounds.maxY * scaledSize - (type === "large" ? 0.18 : 0.14) * scaledSize,
            position.z
        );
        entry.foot.position.set(
            position.x,
            position.y + bounds.minY * scaledSize + (type === "large" ? 0.22 : 0.18) * scaledSize,
            position.z
        );
        entry.rim.rotation.set(Math.PI * 0.5, rotationY, 0);
        entry.foot.rotation.set(Math.PI * 0.5, rotationY, 0);
        entry.rim.scale.setScalar(scaledSize * (1 + sideReveal * 0.04));
        entry.foot.scale.setScalar(scaledSize);
        entry.shell.material.color.copy(new THREE.Color(0xc8d8c9).lerp(new THREE.Color(0xf3ece2), 0.58));
        entry.shell.material.color.lerp(palette.rim, 0.12 + state.heat * 0.06);
        entry.shell.material.emissive.copy(new THREE.Color(0x2b1b12).lerp(palette.glow, 0.14));
        entry.shell.material.emissiveIntensity = (type === "large" ? 0.042 : 0.032) + state.heat * 0.03 + sideReveal * 0.018;
        entry.shell.material.opacity = alpha;
        entry.shell.material.transparent = alpha < 0.999;
        entry.shell.material.clearcoat = 0.88 + state.heat * 0.07;
        entry.shell.material.clearcoatRoughness = 0.14 + (1 - state.heat) * 0.08;
        entry.shell.material.envMapIntensity = 1.06 + sideReveal * 0.18;
        entry.rim.material.color.copy(new THREE.Color(0xf3ede1).lerp(palette.core, 0.18 + state.heat * 0.06));
        entry.rim.material.emissive.copy(new THREE.Color(0x120d0a).lerp(palette.glow, 0.08));
        entry.rim.material.emissiveIntensity = 0.01 + sideReveal * 0.024;
        entry.foot.material.color.copy(new THREE.Color(0xc19872).lerp(new THREE.Color(0xa9744f), state.heat * 0.24));
        entry.foot.material.emissive.copy(new THREE.Color(0x1f140e));
        entry.foot.material.emissiveIntensity = 0.008 + state.heat * 0.008;
    }

    function updateInstances(state, viewState = {}) {
        const time = state.time || 0;
        const layout = resolveProductLayout(state.productType, state.productCount);
        const layoutKey = layout.key;
        const nextAssignments = buildAssignments(state, layout, time);

        if (!displayState.layoutKey) {
            displayState.layoutKey = layoutKey;
            displayState.currentAssignments = nextAssignments;
        } else if (displayState.layoutKey !== layoutKey) {
            displayState.transition = {
                startedAt: time,
                duration: LAYOUT_TRANSITION_DURATION,
                outgoing: displayState.currentAssignments,
                incoming: nextAssignments,
            };
            displayState.layoutKey = layoutKey;
            displayState.currentAssignments = nextAssignments;
        } else {
            displayState.currentAssignments = nextAssignments;
        }

        hideAll();

        if (displayState.transition) {
            const progress = clamp(
                (time - displayState.transition.startedAt) / displayState.transition.duration,
                0,
                1
            );
            const outgoingAlpha = 1 - progress;
            const incomingAlpha = progress;
            displayState.transition.outgoing.forEach((assignment) => {
                applyAssignment(assignment, state, outgoingAlpha, 1 - progress * 0.08, viewState);
            });
            displayState.transition.incoming.forEach((assignment) => {
                applyAssignment(assignment, state, incomingAlpha, 0.92 + progress * 0.08, viewState);
            });
            if (progress >= 1) {
                displayState.transition = null;
            }
        } else {
            displayState.currentAssignments.forEach((assignment) => {
                applyAssignment(assignment, state, 1, 1, viewState);
            });
        }

        group.userData.visualType = layout.productType;
        group.userData.layoutKey = layout.key;
    }

    return {
        group,
        updateInstances,
    };
}

function createFallbackScene(mount) {
    const node = document.createElement("div");
    node.textContent = "WebGL unavailable";
    node.style.cssText = [
        "display:grid",
        "place-items:center",
        "width:100%",
        "height:100%",
        "border-radius:20px",
        "color:#9ed0ff",
        "font:600 14px/1.4 sans-serif",
        "background:linear-gradient(180deg, rgba(7,18,28,.78), rgba(18,40,60,.86))",
    ].join(";");
    mount.replaceChildren(node);
    return {
        updateTelemetry() {},
        setFocusLayer() {
            return "all";
        },
        getSceneBounds() {
            return null;
        },
        fitToViewport() {
            return null;
        },
        resize() {},
        dispose() {
            node.remove();
        },
    };
}

function applyFocusLayer(root, focusLayer) {
    const targetLayer = normalizeFocusLayer(focusLayer);
    root.traverse((node) => {
        if (!node.material) return;
        const materialList = Array.isArray(node.material) ? node.material : [node.material];
        const nodeLayer = node.userData.focusGroup || "structure";
        const emphasis = targetLayer === "all" || nodeLayer === targetLayer
            ? 1
            : nodeLayer === "products"
                ? 0.86
                : nodeLayer === "structure"
                    ? 0.8
                    : 0.72;

        materialList.forEach((material) => {
            if (!material) return;
            material.userData.focusTransparentBase = material.userData.focusTransparentBase ?? material.transparent;
            material.userData.focusDepthWriteBase = material.userData.focusDepthWriteBase ?? material.depthWrite;
            material.transparent = material.userData.focusTransparentBase || emphasis < 0.999;
            material.depthWrite = emphasis < 0.6 ? false : material.userData.focusDepthWriteBase;
            if ("opacity" in material) {
                const baseOpacity = material.userData.focusBaseOpacity ?? material.opacity;
                material.opacity = baseOpacity * emphasis;
            }
            if ("emissiveIntensity" in material) {
                const baseEmissive = material.userData.focusBaseEmissiveIntensity ?? material.emissiveIntensity;
                material.emissiveIntensity = baseEmissive * (emphasis < 1 ? 0.82 + emphasis * 0.14 : 1.08);
            }
        });
    });
}

function updateArrowStream(units, startX, endX, time, color, strength = 1) {
    const direction = endX >= startX ? 1 : -1;
    const intensity = clamp(strength, 0.12, 1.4);
    units.forEach((unit, index) => {
        const phase = (time + index * 0.34) % 1;
        const x = THREE.MathUtils.lerp(startX, endX, phase);
        const emphasis = 0.46 + (1 - phase) * 0.34;
        unit.group.position.x = x;
        unit.group.rotation.z = direction >= 0 ? 0 : Math.PI;
        unit.group.scale.setScalar(0.82 + emphasis * 0.12 + intensity * 0.12);
        [unit.shaft, unit.head].forEach((mesh) => {
            mesh.material.color.copy(color);
            mesh.material.opacity = (0.12 + emphasis * 0.16) * intensity;
        });
    });
}

function snapshotFocusBase(root) {
    root.traverse((node) => {
        if (!node.material) return;
        const materialList = Array.isArray(node.material) ? node.material : [node.material];
        materialList.forEach((material) => {
            if (!material) return;
            material.userData.focusBaseOpacity = material.opacity;
            if ("emissiveIntensity" in material) {
                material.userData.focusBaseEmissiveIntensity = material.emissiveIntensity;
            }
        });
    });
}

function boxToSnapshot(box) {
    box.getCenter(FIT_CENTER);
    box.getSize(FIT_SIZE);
    FIT_MIN.copy(box.min);
    FIT_MAX.copy(box.max);
    return {
        min: { x: FIT_MIN.x, y: FIT_MIN.y, z: FIT_MIN.z },
        max: { x: FIT_MAX.x, y: FIT_MAX.y, z: FIT_MAX.z },
        center: { x: FIT_CENTER.x, y: FIT_CENTER.y, z: FIT_CENTER.z },
        size: { x: FIT_SIZE.x, y: FIT_SIZE.y, z: FIT_SIZE.z },
    };
}

export function createKilnScene(options = {}) {
    const mount = options.mount;
    if (!mount || mount.nodeType !== 1) {
        throw new Error("createKilnScene requires a mount element.");
    }

    const debugCadBadge = typeof document !== "undefined" && /^(127\.0\.0\.1|localhost)$/.test(window.location.hostname)
        ? document.createElement("div")
        : null;
    if (debugCadBadge) {
        debugCadBadge.textContent = "cad: booting";
        debugCadBadge.style.cssText = [
            "position:fixed",
            "left:18px",
            "top:18px",
            "z-index:9999",
            "padding:6px 10px",
            "border-radius:999px",
            "background:rgba(5,12,18,0.82)",
            "color:#d8edf7",
            "font:12px/1.2 monospace",
            "pointer-events:none",
            "box-shadow:0 8px 20px rgba(0,0,0,0.25)",
        ].join(";");
        document.body.appendChild(debugCadBadge);
    }

    const size = readSize(options, mount);
    let renderer;
    try {
        renderer = createRenderer(size.width, size.height);
    } catch (error) {
        console.warn("[kiln-scene] renderer init failed", error);
        return createFallbackScene(mount);
    }

    mount.replaceChildren(renderer.domElement);

    const scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2(0x050d13, 0.0017);
    const environmentMap = createStudioEnvironmentMap(renderer);
    scene.environment = environmentMap;

    const camera = new THREE.PerspectiveCamera(32, size.width / size.height, 0.1, 1400);

    const motionRoot = new THREE.Group();
    motionRoot.name = "kiln-motion-root";
    scene.add(motionRoot);

    const contentRoot = new THREE.Group();
    contentRoot.name = "kiln-content-root";
    motionRoot.add(contentRoot);

    const fitRoot = new THREE.Group();
    fitRoot.name = "kiln-fit-root";
    fitRoot.scale.setScalar(1);
    contentRoot.add(fitRoot);

    const ambientLight = new THREE.HemisphereLight(0xeef7ff, 0x1d2430, 1.22);
    scene.add(ambientLight);

    const keyLight = new THREE.DirectionalLight(0xfbf4e8, 1.94);
    keyLight.position.set(68, 148, 182);
    scene.add(keyLight);

    const rimLight = new THREE.DirectionalLight(0x9ad7ff, 1.08);
    rimLight.position.set(-124, 116, 52);
    scene.add(rimLight);

    const fillLight = new THREE.PointLight(0xadcfff, 1.08, 360, 2);
    fillLight.position.set(0, 92, 118);
    scene.add(fillLight);

    const bounceLight = new THREE.PointLight(0xffe4c6, 0.72, 220, 2);
    bounceLight.position.set(0, -28, 46);
    scene.add(bounceLight);

    const fireLight = new THREE.PointLight(0xffc779, 3.5, 220, 2);
    scene.add(fireLight);

    const structure = createKilnStructure(fitRoot);
    const products = createProductLayer(fitRoot);

    const smokeSystem = createSmokeSystem({
        baseRadius: 4,
        maxHeight: 60,
    });
    smokeSystem.group.position.set(0, KILN_DIMENSIONS.chimneyY + 16, -4);
    assignFocusGroup(smokeSystem.group, "radiation");

    contentRoot.add(smokeSystem.group);

    const state = normalizeTelemetry(options.telemetry || {});
    const initialFlameDynamics = createInitialFlameDynamics(state);
    state.flameDynamics = initialFlameDynamics;
    const targetState = {
        ...state,
        focusLayer: "all",
        flameDynamics: {
            ...initialFlameDynamics,
        },
    };
    state.focusLayer = "all";

    const fitState = {
        padding: clamp(Number(options.fitPadding), 0.06, 0.22) || 0.1,
        initialized: false,
        center: new THREE.Vector3(),
        camera: new THREE.Vector3(),
        desiredCenter: new THREE.Vector3(),
        desiredCamera: new THREE.Vector3(),
        driftX: 0,
        driftY: 0,
        driftZ: 0,
        lastBounds: null,
    };
    const orbitState = {
        yaw: DEFAULT_ORBIT_YAW,
        pitch: DEFAULT_ORBIT_PITCH,
        targetDistance: 240,
        distance: 240,
        minDistance: 170,
        maxDistance: 360,
        dragging: false,
        userInteracted: false,
        pointerId: null,
        lastX: 0,
        lastY: 0,
    };

    let disposed = false;
    let frameId = 0;
    const clock = new THREE.Clock();

    function updateDebugCadBadge() {
        if (!debugCadBadge) return;
        const mounted = globalThis.__burnerCadMounted || 0;
        const last = globalThis.__burnerCadLastMount;
        const error = globalThis.__burnerCadLoadError;
        if (error) {
            debugCadBadge.textContent = `cad err: ${error}`;
            return;
        }
        if (!last) {
            debugCadBadge.textContent = `cad mount:${mounted}`;
            return;
        }
        const minY = Number(last.min?.y ?? 0).toFixed(1);
        const maxY = Number(last.max?.y ?? 0).toFixed(1);
        debugCadBadge.textContent = `cad:${mounted} y:${minY}..${maxY}`;
    }

    function getFitBounds() {
        const box = measureObjectBounds(fitRoot, FIT_BOX, {
            ignoreNode(node) {
                return node.userData?.[EXCLUDE_FROM_FIT_BOUNDS] === true;
            },
        });
        if (box.isEmpty()) {
            box.set(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1));
        }
        return box;
    }

    function getSceneBounds() {
        return boxToSnapshot(getFitBounds());
    }

    function updateViewportFit(delta = 1 / 60, immediate = false) {
        const box = getFitBounds();
        box.getCenter(FIT_CENTER);
        box.getSize(FIT_SIZE);

        const verticalFov = THREE.MathUtils.degToRad(camera.fov);
        const horizontalFov = 2 * Math.atan(Math.tan(verticalFov * 0.5) * camera.aspect);
        const halfWidth = FIT_SIZE.x * 0.5 * (1 + fitState.padding);
        const halfHeight = FIT_SIZE.y * 0.5 * (1 + fitState.padding * 1.08);
        const halfDepth = FIT_SIZE.z * 0.5 * (1 + fitState.padding * 0.42);
        const distance = Math.max(
            halfWidth / Math.tan(horizontalFov * 0.5) + halfDepth,
            halfHeight / Math.tan(verticalFov * 0.5) + halfDepth
        );

        FIT_TARGET.copy(FIT_CENTER);
        FIT_TARGET.y -= FIT_SIZE.y * 0.08;
        FIT_CAMERA.copy(FIT_TARGET);
        FIT_CAMERA.y += FIT_SIZE.y * 0.08;
        FIT_CAMERA.z += Math.max(188, distance * 0.76);

        if (immediate || !fitState.initialized) {
            fitState.center.copy(FIT_TARGET);
            fitState.camera.copy(FIT_CAMERA);
            fitState.initialized = true;
        } else {
            fitState.center.x = damp(fitState.center.x, FIT_TARGET.x, 4.8, delta);
            fitState.center.y = damp(fitState.center.y, FIT_TARGET.y, 4.8, delta);
            fitState.center.z = damp(fitState.center.z, FIT_TARGET.z, 4.8, delta);
            fitState.camera.x = damp(fitState.camera.x, FIT_CAMERA.x, 4.8, delta);
            fitState.camera.y = damp(fitState.camera.y, FIT_CAMERA.y, 4.8, delta);
            fitState.camera.z = damp(fitState.camera.z, FIT_CAMERA.z, 4.8, delta);
        }

        fitState.desiredCenter.copy(FIT_TARGET);
        fitState.desiredCamera.copy(FIT_CAMERA);
        fitState.driftX = Math.min(0.82, 0.18 + FIT_SIZE.x * 0.0008);
        fitState.driftY = Math.min(0.92, 0.22 + FIT_SIZE.y * 0.0014);
        fitState.driftZ = Math.min(1.2, 0.38 + FIT_SIZE.z * 0.0058);
        fitState.lastBounds = boxToSnapshot(box);
        orbitState.minDistance = Math.max(150, distance * 0.68);
        orbitState.maxDistance = Math.max(260, distance * 1.36);
        if (!orbitState.dragging && !orbitState.userInteracted) {
            orbitState.targetDistance = clamp(distance * 0.9, orbitState.minDistance, orbitState.maxDistance);
        }

        return {
            ...fitState.lastBounds,
            padding: fitState.padding,
            cameraPosition: {
                x: fitState.camera.x,
                y: fitState.camera.y,
                z: fitState.camera.z,
            },
            target: {
                x: fitState.center.x,
                y: fitState.center.y,
                z: fitState.center.z,
            },
        };
    }

    function fitToViewport(nextOptions = {}) {
        if (disposed) return null;
        const padding = Number(nextOptions?.padding);
        if (Number.isFinite(padding)) {
            fitState.padding = clamp(padding, 0.06, 0.22);
        }
        if (nextOptions?.resetOrbit) {
            orbitState.userInteracted = false;
            orbitState.dragging = false;
            orbitState.pointerId = null;
            orbitState.yaw = DEFAULT_ORBIT_YAW;
            orbitState.pitch = DEFAULT_ORBIT_PITCH;
        }
        return updateViewportFit(1 / 60, nextOptions?.immediate !== false);
    }

    function bindPointerControls() {
        const element =
            mount.closest?.('.kiln-twin-viewport') ||
            renderer.domElement.parentElement ||
            renderer.domElement;
        element.style.touchAction = "none";
        const onPointerDown = (event) => {
            if (event.button !== 0 && event.pointerType !== "touch") return;
            orbitState.dragging = true;
            orbitState.userInteracted = true;
            orbitState.pointerId = event.pointerId;
            orbitState.lastX = event.clientX;
            orbitState.lastY = event.clientY;
            element.style.cursor = "grabbing";
            element.setPointerCapture?.(event.pointerId);
        };
        const onPointerMove = (event) => {
            if (!orbitState.dragging || orbitState.pointerId !== event.pointerId) return;
            const deltaX = event.clientX - orbitState.lastX;
            const deltaY = event.clientY - orbitState.lastY;
            orbitState.lastX = event.clientX;
            orbitState.lastY = event.clientY;
            orbitState.yaw -= deltaX * 0.0052;
            orbitState.pitch = clamp(orbitState.pitch - deltaY * 0.0042, -0.06, 0.5);
        };
        const stopDrag = (event) => {
            if (event && orbitState.pointerId !== null && orbitState.pointerId !== event.pointerId) return;
            orbitState.dragging = false;
            orbitState.pointerId = null;
            element.style.cursor = "grab";
            if (event) {
            element.releasePointerCapture?.(event.pointerId);
            }
        };
        const onWheel = (event) => {
            event.preventDefault();
            orbitState.userInteracted = true;
            const factor = event.deltaY > 0 ? 1.08 : 0.92;
            orbitState.targetDistance = clamp(
                orbitState.targetDistance * factor,
                orbitState.minDistance,
                orbitState.maxDistance
            );
        };

        element.style.cursor = "grab";
        element.addEventListener("pointerdown", onPointerDown);
        element.addEventListener("pointermove", onPointerMove);
        element.addEventListener("pointerup", stopDrag);
        element.addEventListener("pointercancel", stopDrag);
        element.addEventListener("pointerleave", stopDrag);
        element.addEventListener("wheel", onWheel, { passive: false });

        return () => {
            element.removeEventListener("pointerdown", onPointerDown);
            element.removeEventListener("pointermove", onPointerMove);
            element.removeEventListener("pointerup", stopDrag);
            element.removeEventListener("pointercancel", stopDrag);
            element.removeEventListener("pointerleave", stopDrag);
            element.removeEventListener("wheel", onWheel);
        };
    }

    const unbindPointerControls = bindPointerControls();

    function syncStructure(runtime, time, viewState = {}) {
        const palette = runtime.palette || getKilnPalette(runtime.heat);
        const activeLayout = resolveProductLayout(runtime.productType, runtime.productCount);
        const radiationIsInward = runtime.radiationMode === "inward";
        const flame = runtime.flame || {};
        const flameIntensity = clamp(flame.intensity ?? 0.5, 0.08, 1);
        const orangeRatio = clamp(flame.orangeRatio ?? 0.5, 0, 1);
        const blueRatio = clamp(flame.blueRatio ?? (1 - orangeRatio), 0, 1);
        const sideReveal = clamp(viewState.sideReveal ?? 0, 0, 1);
        const shellApexY = KILN_DIMENSIONS.shellBaseY + archHeight(KILN_DIMENSIONS.shellWidth, KILN_DIMENSIONS.shellShoulderY);

        structure.materials.shell.color.set(0xb56e3f).lerp(new THREE.Color(0xcf8450), runtime.heat * 0.2);
        structure.materials.shell.emissive.copy(new THREE.Color(0x2b160d).lerp(palette.glow, 0.16));
        structure.materials.shell.emissiveIntensity = 0.028 + runtime.heat * 0.03;
        structure.materials.shell.opacity = 0.22 - sideReveal * 0.09;

        structure.materials.shellFace.color.set(0xc17a48).lerp(new THREE.Color(0xd99059), runtime.heat * 0.16);
        structure.materials.shellFace.emissive.copy(new THREE.Color(0x30180d).lerp(palette.glow, 0.12));
        structure.materials.shellFace.emissiveIntensity = 0.024 + runtime.heat * 0.024;
        structure.materials.shellFace.opacity = 0.28 - sideReveal * 0.1;

        structure.materials.chamber.color.set(0xa25e36).lerp(new THREE.Color(0xca7842), runtime.heat * 0.26);
        structure.materials.chamber.emissive.copy(new THREE.Color(0x472414).lerp(palette.glow, 0.16));
        structure.materials.chamber.emissiveIntensity = 0.05 + runtime.heat * 0.05;
        structure.materials.chamber.opacity = 0.38 - sideReveal * 0.16;

        structure.materials.chamberFace.color.set(0xbd7340).lerp(new THREE.Color(0xdc9053), runtime.heat * 0.22);
        structure.materials.chamberFace.emissive.copy(new THREE.Color(0x532917).lerp(palette.glow, 0.18));
        structure.materials.chamberFace.emissiveIntensity = 0.06 + runtime.heat * 0.04;
        structure.materials.chamberFace.opacity = 0.46 - sideReveal * 0.18;

        structure.materials.frame.color.set(0x6f7776).lerp(palette.rim, 0.16);
        structure.materials.frame.emissive.copy(palette.glow);
        structure.materials.frame.emissiveIntensity = 0.025 + runtime.heat * 0.03;

        structure.materials.frameDark.color.set(0x3a4045).lerp(new THREE.Color(0x252a2f), 0.26);
        structure.materials.frameDark.emissive.copy(palette.glow);
        structure.materials.frameDark.emissiveIntensity = 0.02 + runtime.heat * 0.02;

        structure.materials.rack.color.copy(SHELF_BASE_COLOR).lerp(new THREE.Color(0xb39a82), 0.24);
        structure.materials.rack.emissive.copy(palette.glow);
        structure.materials.rack.emissiveIntensity = 0.02 + runtime.heat * 0.02;

        structure.materials.burnerPlate.color.copy(new THREE.Color(0x6f6d6a).lerp(new THREE.Color(0x888581), runtime.heat * 0.05));
        structure.materials.burnerPlate.emissive.copy(new THREE.Color(0x1a1d20).lerp(palette.glow, 0.014));
        structure.materials.burnerPlate.emissiveIntensity = 0.0008 + runtime.heat * 0.0014;
        structure.materials.burnerCup.color.copy(new THREE.Color(0xbc8a6d).lerp(new THREE.Color(0xd1a184), runtime.heat * 0.05));
        structure.materials.burnerCup.emissive.copy(new THREE.Color(0x28160f).lerp(palette.glow, 0.045));
        structure.materials.burnerCup.emissiveIntensity = 0.002 + runtime.heat * 0.0035;
        structure.materials.burnerBase.color.copy(new THREE.Color(0xd2d0cd).lerp(new THREE.Color(0xe7e3de), runtime.heat * 0.04));
        structure.materials.burnerBase.emissive.copy(new THREE.Color(0x1b2023).lerp(palette.glow, 0.02));
        structure.materials.burnerBase.emissiveIntensity = 0.0012 + runtime.heat * 0.0018;
        structure.materials.burnerPipe.color.copy(new THREE.Color(0xd0d4d8).lerp(new THREE.Color(0xe0e4ea), runtime.heat * 0.04));
        structure.materials.burnerPipe.emissive.copy(new THREE.Color(0x171c1f).lerp(palette.glow, 0.018));
        structure.materials.burnerPipe.emissiveIntensity = 0.001 + runtime.heat * 0.0016;
        structure.materials.burnerFace.color.copy(new THREE.Color(0xcfd0d0).lerp(new THREE.Color(0xe7e3de), runtime.heat * 0.04));
        structure.materials.burnerFace.emissive.copy(new THREE.Color(0x1a1d20).lerp(palette.glow, 0.015));
        structure.materials.burnerFace.emissiveIntensity = 0.0009 + runtime.heat * 0.0015;
        structure.materials.burnerNozzleCup.color.copy(new THREE.Color(0xab7a60).lerp(new THREE.Color(0xbc8a6d), runtime.heat * 0.08));
        structure.materials.burnerNozzleCup.emissive.copy(new THREE.Color(0x28160f).lerp(palette.glow, 0.05));
        structure.materials.burnerNozzleCup.emissiveIntensity = 0.003 + runtime.heat * 0.005;
        structure.materials.burnerInsert.color.copy(new THREE.Color(0x34160e).lerp(new THREE.Color(0x4f2415), runtime.heat * 0.04));
        structure.materials.burnerInsert.emissive.copy(new THREE.Color(0x100a08).lerp(palette.glow, 0.026));
        structure.materials.burnerInsert.emissiveIntensity = 0.0012 + runtime.heat * 0.002;
        structure.materials.burnerCeramic.color.copy(new THREE.Color(0xb8a15d).lerp(new THREE.Color(0xd0bc75), runtime.heat * 0.06));
        structure.materials.burnerCeramic.emissive.copy(new THREE.Color(0x2a2113).lerp(palette.glow, 0.035));
        structure.materials.burnerCeramic.emissiveIntensity = 0.0014 + runtime.heat * 0.0024;

        structure.shellBack.material.color.set(0xb46b3b).lerp(new THREE.Color(0xcb8452), runtime.heat * 0.16);
        structure.shellBack.material.emissive.copy(palette.glow);
        structure.shellBack.material.emissiveIntensity = 0.026 + runtime.heat * 0.03;

        structure.chamberBack.material.color.set(0xc57740).lerp(new THREE.Color(0xe4995b), runtime.heat * 0.18);
        structure.chamberBack.material.emissive.copy(palette.glow);
        structure.chamberBack.material.emissiveIntensity = 0.05 + runtime.heat * 0.04;

        structure.heatVeil.material.color.copy(radiationIsInward ? new THREE.Color(0x69baff) : new THREE.Color(0xff875c));
        structure.heatVeil.material.opacity = 0.008 + runtime.radiationIntensity * 0.026;
        structure.heatVeil.scale.set(
            radiationIsInward ? 0.96 : 1.04,
            radiationIsInward ? 0.92 : 1.02,
            1
        );

        structure.haloRing.material.color.copy(palette.glow);
        structure.haloRing.material.opacity = 0.004 + runtime.heat * 0.004;
        structure.haloRing.scale.setScalar(1);
        structure.haloDisc.material.color.copy(palette.rim);
        structure.haloDisc.material.opacity = 0.002 + runtime.heat * 0.003;
        structure.baseShadow.material.opacity = 0.22 + runtime.heat * 0.06;
        structure.shellFront.visible = false;
        structure.shellFrontEdge.visible = false;
        structure.shellBodyEdge.material.color.copy(palette.rim);
        structure.shellBodyEdge.material.opacity = 0.04 + sideReveal * 0.03;
        structure.shellInnerBand.material.opacity = 0.014;
        structure.chamberEdge.material.color.copy(palette.glow);
        structure.chamberEdge.material.opacity = 0.12 + sideReveal * 0.05;
        structure.chamberRevealEdge.material.color.copy(palette.core);
        structure.chamberRevealEdge.material.opacity = 0.1 + sideReveal * 0.05;
        structure.doorFrameEdge.material.color.copy(palette.rim);
        structure.doorFrameEdge.material.opacity = 0.16 + sideReveal * 0.08;

        structure.doorPivot.rotation.y = 0;
        structure.door.rotation.z = 0;
        structure.smokeStack.position.set(0, shellApexY + 4, -2.5);
        structure.smokeNeck.material.emissive.copy(palette.glow);
        structure.smokeNeck.material.emissiveIntensity = 0.04 + runtime.emissionLevel * 0.08;
        structure.smokeCap.material.emissive.copy(palette.glow);
        structure.smokeCap.material.emissiveIntensity = 0.03 + runtime.emissionLevel * 0.05;
        structure.smokeLip.material.emissive.copy(palette.glow);
        structure.smokeLip.material.emissiveIntensity = 0.03 + runtime.emissionLevel * 0.04;

        structure.shelves.forEach((shelf, index) => {
            const visible = activeLayout.activeShelfIndexes.includes(index);
            shelf.slab.visible = visible;
            shelf.lip.visible = visible;
            shelf.brace.visible = visible;
            if (!visible) return;
            shelf.slab.position.y = SHELF_LEVELS[index];
            shelf.lip.position.y = SHELF_LEVELS[index] + 0.8;
            shelf.brace.position.y = SHELF_LEVELS[index] + 0.8;
            shelf.slab.material.color.copy(new THREE.Color(0xb58f6d)).lerp(new THREE.Color(0xcfab86), 0.18);
            shelf.slab.material.emissive.copy(palette.glow);
            shelf.slab.material.emissiveIntensity = 0.025 + runtime.heat * 0.025;
        });

        const flameProfile = runtime.flameProfile || {};
        const flameDynamics = runtime.flameDynamics || createInitialFlameDynamics(runtime);
        const driftStrength = 0.16 + (flameProfile.bandDrift ?? 0.55) * 0.28 + flameDynamics.agitation * 0.42;
        const heatBoost = flameProfile.chamberHeat ?? 0.78;

        structure.burners.forEach((entry, index) => {
            const phase = flameDynamics.phase + index * 0.34;
            const heightPulse = 1 + Math.sin(phase * 2.4 + index * 0.4) * (0.08 + flameDynamics.agitation * 0.14);
            const bodyPulseX = 1 + Math.sin(phase * 2.9 + index * 0.8) * (0.05 + flameDynamics.agitation * 0.16);
            const bodyPulseZ = 1 + Math.cos(phase * 2.3 + index * 0.6) * (0.05 + flameDynamics.agitation * 0.14);
            const tipSway = Math.sin(phase * 1.7 + index * 0.5) * driftStrength + Math.sin(phase * 3.1 + index * 0.9) * driftStrength * 0.34;
            const tipLift = Math.sin(phase * 2.6 + index * 0.7) * (0.8 + flameDynamics.responseBoost * 2.8);
            const tipDriftZ = Math.cos(phase * 2.1 + index * 0.8) * (0.1 + flameDynamics.agitation * 0.24);
            const nozzleScale = 0.9 + flameIntensity * 0.18 + activeLayout.flameRadius * 0.012;
            const nozzleAnchorRadius = NOZZLE_RING_OUTER_RADIUS * nozzleScale * 0.96;
            const volumeHeight = flameDynamics.height * heightPulse;
            const volumeRadiusX = flameDynamics.radius * bodyPulseX;
            const volumeRadiusZ = flameDynamics.radius * bodyPulseZ;
            const flameWarm = new THREE.Color(0xff8f2b).lerp(new THREE.Color(0xffebb8), orangeRatio * 0.36);
            const flameCool = new THREE.Color(0x4ca5ff).lerp(new THREE.Color(0xbcecff), blueRatio * 0.42);
            const nozzleColor = flameCool.clone().lerp(flameWarm, orangeRatio * 0.28);
            entry.group.position.set((index === 0 ? -1 : 1) * activeLayout.burnerX, activeLayout.burnerY, activeLayout.burnerZ);
            entry.basePlate.scale.set(1.06, 1, 1.06);
            entry.pedestal.scale.set(1.03, 1.02, 1.03);
            entry.burnerCup.scale.set(1, 1, 1);
            if (entry.burnerFace) {
                entry.burnerFace.scale.set(1, 1, 1);
            }
            entry.burnerShadow.material.opacity = 0.18 + runtime.heat * 0.06;
            entry.nozzleRing.material.color.copy(nozzleColor);
            entry.nozzleRing.material.opacity = 0;
            entry.nozzleRing.scale.set(
                1,
                1,
                1
            );
            entry.flameVolume.material.uniforms.phase.value = flameDynamics.phase;
            entry.flameVolume.material.uniforms.agitation.value = flameDynamics.agitation;
            entry.flameVolume.material.uniforms.intensity.value = flameIntensity;
            entry.flameVolume.material.uniforms.orangeRatio.value = orangeRatio;
            entry.flameVolume.material.uniforms.blueRatio.value = blueRatio;
            setAnchoredFlameVolumeTransform(
                entry.flameVolume,
                volumeRadiusX / FLAME_VOLUME_BASE_RADIUS,
                volumeHeight + tipLift * 0.8,
                volumeRadiusZ / FLAME_VOLUME_BASE_RADIUS,
                entry.nozzleRing.position.y - NOZZLE_RING_TUBE_RADIUS,
                tipSway * 0.1,
                tipDriftZ * 0.2,
                tipDriftZ * 0.08,
                tipSway * 0.02
            );
            setAnchoredFlameVolumeTransform(
                entry.flameCore,
                Math.max(0.22, volumeRadiusX * 0.36) / FLAME_VOLUME_BASE_RADIUS,
                Math.max(4.8, volumeHeight * 0.68 + tipLift * 0.26),
                Math.max(0.18, volumeRadiusZ * 0.3) / FLAME_VOLUME_BASE_RADIUS,
                entry.nozzleRing.position.y - NOZZLE_RING_TUBE_RADIUS,
                tipSway * 0.05,
                tipDriftZ * 0.08,
                tipDriftZ * 0.04,
                tipSway * 0.01
            );
            entry.flameCore.material.color.copy(new THREE.Color(0xfff6d2).lerp(flameWarm, 0.22));
            entry.flameCore.material.opacity = 0.1 + flameIntensity * 0.11 + orangeRatio * 0.04;

            setAnchoredFlameVolumeTransform(
                entry.innerCone,
                Math.max(0.18, volumeRadiusX * 0.18) / FLAME_VOLUME_BASE_RADIUS,
                Math.max(2.6, volumeHeight * 0.26),
                Math.max(0.16, volumeRadiusZ * 0.16) / FLAME_VOLUME_BASE_RADIUS,
                entry.nozzleRing.position.y - NOZZLE_RING_TUBE_RADIUS,
                tipSway * 0.015,
                tipDriftZ * 0.03,
                tipDriftZ * 0.012,
                tipSway * 0.004
            );
            entry.innerCone.material.color.copy(new THREE.Color(0x7cc7ff).lerp(new THREE.Color(0xcaf0ff), blueRatio * 0.35));
            entry.innerCone.material.opacity = 0.16 + blueRatio * 0.12 + flameIntensity * 0.03;

            entry.flameGlow.material.color.copy(flameWarm);
            entry.flameGlow.material.opacity = 0.02 + heatBoost * 0.026 + flameIntensity * 0.02;
            entry.flameGlow.scale.set(
                nozzleAnchorRadius * 0.96 + Math.sin(phase * 1.9 + index) * 0.12,
                Math.max(2.4, volumeHeight * 0.18 + flameIntensity * 0.6),
                nozzleAnchorRadius * 0.9 + Math.cos(phase * 1.7 + index * 0.5) * 0.12
            );
            entry.flameGlow.position.set(0, entry.nozzleRing.position.y + Math.max(1.8, volumeHeight * 0.08), 0.16);

            entry.flameHalo.material.color.copy(flameCool);
            entry.flameHalo.material.opacity = 0.008 + blueRatio * 0.02;
            entry.flameHalo.scale.set(
                nozzleAnchorRadius * 1.04 + Math.sin(phase * 1.1 + index * 0.8) * 0.08,
                Math.max(2.8, volumeHeight * 0.22 + flameIntensity * 0.42),
                nozzleAnchorRadius * 1 + Math.cos(phase * 1.25 + index * 0.5) * 0.08
            );
            entry.flameHalo.position.set(0, entry.nozzleRing.position.y + Math.max(2.2, volumeHeight * 0.12), 0.12);
            entry.heatShell.material.color.copy(new THREE.Color(0xffd59e).lerp(flameWarm, 0.22));
            entry.heatShell.material.opacity = 0.006 + flameIntensity * 0.014 + heatBoost * 0.01;
            entry.heatShell.scale.set(
                nozzleAnchorRadius * 1.14 + Math.sin(phase * 0.9 + index) * 0.08,
                Math.max(3.2, volumeHeight * 0.18 + flameIntensity * 0.52),
                nozzleAnchorRadius * 1.08 + Math.cos(phase * 0.8 + index * 0.7) * 0.08
            );
            entry.heatShell.position.set(0, entry.nozzleRing.position.y + Math.max(2.4, volumeHeight * 0.14), 0.14);

            if (entry.nozzleCups && entry.nozzleCups.length) {
                entry.nozzleCups.forEach((cup, cupIndex) => {
                    const cupPhase = phase * 3.3 + cupIndex * 0.72;
                    const glowColor = flameCool.clone().lerp(flameWarm, 0.4 + orangeRatio * 0.42);
                    cup.glow.material.color.copy(glowColor);
                    cup.glow.material.opacity = clamp(0.03 + blueRatio * 0.08 + flameIntensity * 0.04, 0.01, 0.16);
                    cup.glow.position.y = cup.baseGlowY ?? -0.18;
                    cup.sleeve.scale.y = 1;
                });
            }
            if (entry.corePorts && entry.corePorts.length) {
                entry.corePorts.forEach((port, portIndex) => {
                    const portPhase = phase * 2.6 + portIndex * 1.17;
                    const isCenter = port.radius < 0.1;
                    const centerBoost = isCenter ? 0.03 + flameIntensity * 0.06 : 0;
                    const portColor = flameCool.clone().lerp(new THREE.Color(0xd8f1ff), 0.32 + blueRatio * 0.28);
                    port.glow.material.color.copy(portColor);
                    port.glow.material.opacity = clamp(0.02 + blueRatio * 0.08 + centerBoost, 0.01, 0.14);
                    port.glow.position.y = (port.baseY ?? 27.48) + centerBoost * 0.08;
                });
            }
            if (entry.coreJets && entry.coreJets.length) {
                const coreBaseY = entry.nozzleRing.position.y + 0.42;
                const coreHeightBase = Math.max(2.8, volumeHeight * (0.26 + orangeRatio * 0.16));
                const coreRadiusBase = Math.max(0.11, nozzleAnchorRadius * 0.028 + flameIntensity * 0.05);

                entry.coreJets.forEach((jet, jetIndex) => {
                    const jetPhase = phase * (2.8 + flameDynamics.agitation * 0.56) + jet.phaseOffset;
                    const pulse = 0.84 + Math.sin(jetPhase * 1.7) * 0.16 + Math.cos(jetPhase * 2.2 + jetIndex * 0.4) * 0.08;
                    const isCenter = !!jet.isCenter;
                    const jetX = isCenter ? 0 : (jet.x ?? Math.cos(jet.angle) * jet.radius);
                    const jetZ = isCenter ? 0 : (jet.z ?? Math.sin(jet.angle) * jet.radius);
                    const jetHeight = clamp(
                        coreHeightBase * (isCenter ? 1.18 + flameIntensity * 0.18 : 0.8 + orangeRatio * 0.12) * pulse,
                        isCenter ? 3.2 : 1.8,
                        volumeHeight * (isCenter ? 0.98 : 0.6)
                    );
                    const jetRadius = clamp(
                        coreRadiusBase * (isCenter ? 1.18 : 0.82) * (0.94 + pulse * 0.16),
                        0.08,
                        isCenter ? 0.78 : 0.42
                    );
                    const radialTiltX = isCenter ? tipDriftZ * 0.014 : Math.sin(jet.angle) * (0.02 + flameDynamics.agitation * 0.014);
                    const radialTiltZ = isCenter ? tipSway * 0.008 : -Math.cos(jet.angle) * (0.02 + flameDynamics.agitation * 0.014);

                    jet.group.position.set(jetX, coreBaseY + Math.sin(jetPhase * 1.4) * 0.06, jetZ);
                    setAnchoredFlameVolumeTransform(
                        jet.shell,
                        jetRadius,
                        jetHeight,
                        jetRadius * 0.94,
                        0,
                        0,
                        0,
                        radialTiltX,
                        radialTiltZ
                    );
                    jet.shell.material.color.copy(flameWarm.clone().lerp(new THREE.Color(0xffd3a2), isCenter ? 0.42 : 0.3));
                    jet.shell.material.opacity = clamp(
                        (isCenter ? 0.13 : 0.1) + flameIntensity * 0.08 + orangeRatio * 0.07 + pulse * 0.03,
                        0.08,
                        isCenter ? 0.52 : 0.34
                    );

                    setAnchoredFlameVolumeTransform(
                        jet.core,
                        jetRadius * (isCenter ? 0.46 : 0.38),
                        jetHeight * (isCenter ? 0.56 + blueRatio * 0.18 : 0.48 + blueRatio * 0.14),
                        jetRadius * (isCenter ? 0.42 : 0.34),
                        0.01,
                        0,
                        0,
                        radialTiltX * 0.72,
                        radialTiltZ * 0.72
                    );
                    jet.core.material.color.copy(flameCool.clone().lerp(new THREE.Color(0xe8f8ff), blueRatio * (isCenter ? 0.48 : 0.36)));
                    jet.core.material.opacity = clamp(
                        (isCenter ? 0.16 : 0.12) + blueRatio * 0.15 + flameIntensity * 0.05,
                        0.08,
                        isCenter ? 0.58 : 0.42
                    );

                    jet.halo.position.set(0, Math.max(0.26, jetHeight * 0.32), 0);
                    jet.halo.scale.setScalar(isCenter ? 1.14 + pulse * 0.2 : 0.92 + pulse * 0.16);
                    jet.halo.material.color.copy(flameWarm.clone().lerp(flameCool, 0.26 + blueRatio * 0.24));
                    jet.halo.material.opacity = clamp(
                        (isCenter ? 0.05 : 0.035) + flameIntensity * 0.04 + blueRatio * 0.03,
                        0.02,
                        isCenter ? 0.24 : 0.16
                    );
                });
            }
            if (entry.pilotJets && entry.pilotJets.length) {
                const pilotOrbitRadius = entry.pilotOrbitRadius ?? 12.4;
                const pilotBaseY = entry.nozzleRing.position.y + 1.36;
                const pilotHeightBase = Math.max(2.1, volumeHeight * (0.28 + orangeRatio * 0.18));
                const pilotRadiusBase = Math.max(0.12, nozzleAnchorRadius * 0.04 + flameIntensity * 0.06);
                const pilotTiltBase = 0.02 + flameDynamics.agitation * 0.05;

                entry.pilotJets.forEach((jet, jetIndex) => {
                    const jetPhase = phase * (3.2 + flameDynamics.agitation * 0.82) + jet.phaseOffset;
                    const jetPulse = 0.72 + Math.sin(jetPhase * 1.8) * 0.2 + Math.cos(jetPhase * 2.6 + jetIndex) * 0.1;
                    const jetX = Math.cos(jet.angle) * pilotOrbitRadius;
                    const jetZ = Math.sin(jet.angle) * pilotOrbitRadius;
                    const jetHeight = clamp(pilotHeightBase * jetPulse * (0.85 + flameIntensity * 0.22), 1.2, volumeHeight * 0.78);
                    const jetRadius = clamp(pilotRadiusBase * (0.78 + jetPulse * 0.34), 0.08, 0.95);
                    const radialTiltX = Math.sin(jet.angle) * pilotTiltBase;
                    const radialTiltZ = -Math.cos(jet.angle) * pilotTiltBase;

                    jet.group.position.set(jetX, pilotBaseY, jetZ);
                    setAnchoredFlameVolumeTransform(
                        jet.shell,
                        jetRadius,
                        jetHeight,
                        jetRadius,
                        0,
                        0,
                        0,
                        radialTiltX,
                        radialTiltZ
                    );
                    jet.shell.material.color.copy(flameWarm.clone().lerp(new THREE.Color(0xffca8a), 0.36));
                    jet.shell.material.opacity = clamp(0.09 + flameIntensity * 0.09 + orangeRatio * 0.08 + jetPulse * 0.04, 0.06, 0.46);

                    setAnchoredFlameVolumeTransform(
                        jet.core,
                        jetRadius * 0.5,
                        jetHeight * (0.48 + blueRatio * 0.2),
                        jetRadius * 0.5,
                        0.02,
                        0,
                        0,
                        radialTiltX * 0.72,
                        radialTiltZ * 0.72
                    );
                    jet.core.material.color.copy(flameCool.clone().lerp(new THREE.Color(0xe2f6ff), blueRatio * 0.4));
                    jet.core.material.opacity = clamp(0.12 + blueRatio * 0.16 + flameIntensity * 0.06, 0.08, 0.54);

                    jet.halo.position.set(0, Math.max(0.3, jetHeight * 0.34), 0);
                    jet.halo.scale.set(
                        1 + jetPulse * 0.28,
                        1 + jetPulse * 0.26,
                        1 + jetPulse * 0.28
                    );
                    jet.halo.material.color.copy(flameWarm.clone().lerp(flameCool, 0.32 + blueRatio * 0.24));
                    jet.halo.material.opacity = clamp(0.03 + flameIntensity * 0.06 + blueRatio * 0.04, 0.01, 0.22);
                });
            }
        });

        structure.arrowLayer.rows.forEach((entry, index) => {
            const rowY = activeLayout.arrowRows[index];
            const visible = Number.isFinite(rowY);
            entry.row.visible = visible;
            if (!visible) return;
            entry.row.position.set(0, rowY, -7.5);
            const arrowColor = radiationIsInward ? new THREE.Color(0x5f9be0) : new THREE.Color(0xd47961);
            const streamTime = (time * (0.34 + runtime.radiationIntensity * 0.24) + index * 0.11) % 1;
            updateArrowStream(
                entry.leftUnits,
                radiationIsInward ? -40 : -8,
                radiationIsInward ? -8 : -40,
                streamTime,
                arrowColor,
                0.5 + runtime.radiationIntensity * 0.9
            );
            updateArrowStream(
                entry.rightUnits,
                radiationIsInward ? 40 : 8,
                radiationIsInward ? 8 : 40,
                streamTime,
                arrowColor,
                0.5 + runtime.radiationIntensity * 0.9
            );
        });

        const firePulse = 0.86 + Math.sin(time * 17.5) * 0.08 + Math.cos(time * 11.2) * 0.05;
        fireLight.color.copy(new THREE.Color(0xffe0b4).lerp(new THREE.Color(0xff9952), orangeRatio * 0.74));
        fireLight.position.set(0, radiationIsInward ? -10 : -14, 8);
        fireLight.intensity = (1.2 + flameIntensity * 2.4 + flameDynamics.responseBoost * 0.72) * firePulse;
        fireLight.distance = 136 + flameDynamics.radius * 2.8;
        bounceLight.color.copy(new THREE.Color(0xffedd4).lerp(new THREE.Color(0xffbe84), orangeRatio * 0.46));
        bounceLight.intensity = 0.42 + flameIntensity * 0.92;
        bounceLight.distance = 188 + flameDynamics.radius * 2.1;
    }

    function animate() {
        if (disposed) return;
        frameId = window.requestAnimationFrame(animate);
        const delta = Math.min(clock.getDelta(), 0.05);
        const elapsed = clock.elapsedTime;

        state.temperature = damp(state.temperature, targetState.temperature, 4.2, delta);
        state.heat = damp(state.heat, targetState.heat, 4.4, delta);
        state.radiationIntensity = damp(state.radiationIntensity, targetState.radiationIntensity, 4.1, delta);
        state.efficiency = damp(state.efficiency, targetState.efficiency, 3.8, delta);
        state.emissionLevel = damp(state.emissionLevel, targetState.emissionLevel, 3.8, delta);
        state.flame = state.flame || { blueRatio: 0.5, orangeRatio: 0.5, intensity: 0.4 };
        state.flame.blueRatio = damp(state.flame.blueRatio, targetState.flame?.blueRatio ?? state.flame.blueRatio, 4, delta);
        state.flame.orangeRatio = damp(state.flame.orangeRatio, targetState.flame?.orangeRatio ?? state.flame.orangeRatio, 4, delta);
        state.flame.intensity = damp(state.flame.intensity, targetState.flame?.intensity ?? state.flame.intensity, 4.2, delta);
        state.flameProfile = targetState.flameProfile;
        state.flameDynamics = state.flameDynamics || createInitialFlameDynamics(state);
        const flameDynamicsTarget = targetState.flameDynamics || createInitialFlameDynamics(targetState);
        state.flameDynamics.heightTarget = flameDynamicsTarget.heightTarget;
        state.flameDynamics.radiusTarget = flameDynamicsTarget.radiusTarget;
        state.flameDynamics.agitationTarget = flameDynamicsTarget.agitationTarget;
        state.flameDynamics.phaseSpeedTarget = flameDynamicsTarget.phaseSpeedTarget;
        state.flameDynamics.responseBoostTarget = flameDynamicsTarget.responseBoostTarget;
        state.flameDynamics.nozzleScale = flameDynamicsTarget.nozzleScale;
        state.flameDynamics.nozzleAnchorRadius = flameDynamicsTarget.nozzleAnchorRadius;
        state.flameDynamics.height = damp(state.flameDynamics.height, flameDynamicsTarget.heightTarget, 4.4, delta);
        state.flameDynamics.radius = damp(state.flameDynamics.radius, flameDynamicsTarget.radiusTarget, 4.8, delta);
        state.flameDynamics.agitation = damp(state.flameDynamics.agitation, flameDynamicsTarget.agitationTarget, 4.6, delta);
        state.flameDynamics.phaseSpeed = damp(state.flameDynamics.phaseSpeed, flameDynamicsTarget.phaseSpeedTarget, 3.8, delta);
        const responseLambda = state.flameDynamics.responseBoost <= flameDynamicsTarget.responseBoostTarget ? 8.5 : 2.4;
        state.flameDynamics.responseBoost = damp(state.flameDynamics.responseBoost, flameDynamicsTarget.responseBoostTarget, responseLambda, delta);
        state.flameDynamics.phase += delta * state.flameDynamics.phaseSpeed;
        state.productType = targetState.productType;
        state.productCount = targetState.productCount;
        state.productSpec = targetState.productSpec;
        state.radiationMode = targetState.radiationMode;
        state.radiationState = targetState.radiationState;
        state.focusLayer = targetState.focusLayer;
        state.palette = getKilnPalette(state.heat);
        state.time = elapsed;

        const sideReveal = clamp(
            (Math.abs(Math.sin(orbitState.yaw)) - 0.26) / 0.58,
            0,
            1
        );
        const viewState = {
            sideReveal,
            yaw: orbitState.yaw,
            pitch: orbitState.pitch,
        };

        syncStructure(state, elapsed, viewState);
        products.updateInstances(state, viewState);
        smokeSystem.update(state, delta);
        snapshotFocusBase(contentRoot);
        applyFocusLayer(contentRoot, state.focusLayer);

        updateViewportFit(delta);
        orbitState.distance = damp(orbitState.distance, orbitState.targetDistance, 5.2, delta);

        motionRoot.rotation.y = 0;
        motionRoot.rotation.z = 0;
        motionRoot.position.y = 0;

        const idleYaw = 0;
        const idlePitch = 0;
        const viewPitch = clamp(orbitState.pitch + idlePitch, -0.06, 0.54);
        const viewYaw = orbitState.yaw + idleYaw;
        const viewDistance = orbitState.distance;
        const planarDistance = Math.cos(viewPitch) * viewDistance;

        ORBIT_OFFSET.set(
            Math.sin(viewYaw) * planarDistance,
            Math.sin(viewPitch) * viewDistance,
            Math.cos(viewYaw) * planarDistance
        );

        camera.position.copy(fitState.center).add(ORBIT_OFFSET);
        camera.position.y += FIT_SIZE.y * 0.08;
        FIT_CAMERA_TARGET.copy(fitState.center);
        FIT_CAMERA_TARGET.y += FIT_SIZE.y * 0.02;
        camera.lookAt(FIT_CAMERA_TARGET);
        updateDebugCadBadge();

        renderer.render(scene, camera);
    }

    function updateTelemetry(nextTelemetry = {}) {
        const next = normalizeTelemetry(nextTelemetry, targetState);
        next.flameDynamics = {
            ...(targetState.flameDynamics || {}),
            ...deriveFlameDynamicsTargets(next, computeFlameResponseBoostTarget(next, targetState)),
        };
        Object.assign(targetState, next);
        return { ...targetState };
    }

    function setStructurePreset(preset) {
        const productType = preset === "large" ? "large" : "small";
        return updateTelemetry({
            productType,
            product_type: productType,
        });
    }

    function setFocusLayer(layerKey) {
        targetState.focusLayer = normalizeFocusLayer(layerKey);
        return targetState.focusLayer;
    }

    function resize(nextSize = {}) {
        if (disposed) return;
        const resolved = readSize(nextSize, mount);
        renderer.setSize(resolved.width, resolved.height, false);
        camera.aspect = resolved.width / resolved.height;
        camera.updateProjectionMatrix();
        fitToViewport({ immediate: true });
    }

    function dispose() {
        if (disposed) return;
        disposed = true;
        if (frameId) window.cancelAnimationFrame(frameId);
        unbindPointerControls?.();
        disposeObject3D(motionRoot);
        environmentMap.dispose?.();
        renderer.dispose();
        mount.replaceChildren();
    }

    updateTelemetry(options.telemetry || {});
    fitToViewport({ immediate: true, resetOrbit: true });
    resize(size);
    animate();

    return {
        updateTelemetry,
        setStructurePreset,
        setFocusLayer,
        getSceneBounds,
        fitToViewport,
        resetView() {
            return fitToViewport({ immediate: true, resetOrbit: true });
        },
        resize,
        dispose,
    };
}

if (typeof window !== "undefined") {
    window.createKilnScene = createKilnScene;
}
