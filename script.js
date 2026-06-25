const queryString = window.location.search;
const urlParams = new URLSearchParams(queryString);
const token = urlParams.get("token") || "";
const visibilityDuration = parseInt(urlParams.get("duration")) || 0;
const hideAlbumArt = urlParams.has("hideAlbumArt");

const appId = "nuttys-ytmdesktop-widget";
const appName = "YouTube Music Widget";
const appVersion = "1.0.0";
let browserSourceURL = "";

const scaleFactor = 1920 / 1504;
const mainContainer = document.getElementById('mainContainer');
if (mainContainer) {
    mainContainer.style.transform = `scale(${scaleFactor})`;
    mainContainer.style.transformOrigin = "center";
}

if (hideAlbumArt) {
    const artEl = document.getElementById("albumArt");
    if (artEl) artEl.style.display = "none";
}

if (token === "") {
    const setupContainer = document.getElementById("setupContainer");
    const authBox = document.getElementById("authorizationBox");
    if (setupContainer) setupContainer.style.display = "flex";
    if (authBox) authBox.style.display = "block";
    RequestToken();
} else {
    connectws();
}

async function RequestCode() {
    try {
        const response = await fetch("http://localhost:9863/api/v1/auth/requestcode", {
            method: "POST",
            body: JSON.stringify({ "appId": appId, "appName": appName, "appVersion": appVersion }),
            headers: { "Content-type": "application/json; charset=UTF-8" }
        });
        const data = await response.json();
        if (data.hasOwnProperty("statusCode")) {
            ShowError(data.statusCode, data.message);
            return null;
        }
        return data;
    } catch (e) {
        ShowError("Connection Error", "Is YTMDesktop running?");
        return null;
    }
}

async function RequestToken() {
    const requestCode = await RequestCode();
    if (!requestCode) return;

    const authCode = requestCode.code;
    const codeEl = document.getElementById("authorizationCode");
    if (codeEl) codeEl.innerText = authCode;

    try {
        const response = await fetch("http://localhost:9863/api/v1/auth/request", {
            method: "POST",
            body: JSON.stringify({ "appId": appId, "code": authCode }),
            headers: { "Content-type": "application/json; charset=UTF-8" }
        });
        const data = await response.json();

        if (data.hasOwnProperty("statusCode")) {
            ShowError(data.statusCode, data.message);
        } else {
            browserSourceURL = `https://LostXC.github.io/MusicPlayerWidgetEseninocafe?token=${data.token}`;
            const btn = document.getElementById("copyURLButton");
            if (btn) {
                btn.disabled = false;
                btn.innerText = "Click to copy URL";
            }
            if (codeEl) codeEl.style.display = 'none';
            const completeEl = document.getElementById("authorizationComplete");
            if (completeEl) completeEl.style.display = 'block';
        }
    } catch (e) {
        ShowError("Token Error", "Failed to get authorization token.");
    }
}

window.CopyToURL = function() {
    navigator.clipboard.writeText(browserSourceURL);
    const btn = document.getElementById("copyURLButton");
    if (btn) {
        btn.innerText = "Copied to clipboard!";
        btn.style.backgroundColor = "#00dd63";
        btn.style.color = "#ffffff";
        setTimeout(() => {
            btn.innerText = "Click to copy URL";
            btn.style.backgroundColor = "#ffffff";
            btn.style.color = "#181818";
        }, 3000);
    }
}

function ShowError(code, msg) {
    const errCodeEl = document.getElementById("errorCode");
    const errMsgEl = document.getElementById("errorMessage");
    const errBoxEl = document.getElementById("errorBox");
    const authBoxEl = document.getElementById("authorizationBox");
    if (errCodeEl) errCodeEl.innerText = "Error: " + code;
    if (errMsgEl) errMsgEl.innerText = msg;
    if (errBoxEl) errBoxEl.style.display = 'block';
    if (authBoxEl) authBoxEl.style.display = 'none';
}

window.CloseErrorBox = function() {
    const errBoxEl = document.getElementById("errorBox");
    if (errBoxEl) errBoxEl.style.display = 'none';
}

// ── SKULL CONFIG & PRELOAD ──
const SKULL_CFG = {
    scale: 0.90,
    framesCount: 23,
    fps: 25,
    sx: 36, sy: 506, sw: 110, sh: 130,
    dx: -34, dy: -50
};

const skullFrames = [];
function preloadSkull() {
    for (let i = 0; i < SKULL_CFG.framesCount; i++) {
        const img = new Image();
        img.src = `assets/skull/Test.${String(i).padStart(5, '0')}.svg`;
        skullFrames.push(img);
    }
}
preloadSkull();
// ────────────────────────────

const BOIL_CFG = {
    cornerRadius: 20, strokeWidth: 7, noiseFreq: 4.2, noiseCoordScale: 0.006,
    noiseTimeScale: 1.0, noiseAmp: 1.5, divW: 240, divH: 80, divCorner: 10, padding: 30
};

const Simplex3D = (function () {
    const F3 = 1.0 / 3.0, G3 = 1.0 / 6.0;
    const p = new Uint8Array([151,160,137,91,90,15,131,13,201,95,96,53,194,233,7,225,140,36,103,30,69,142,8,99,37,240,21,10,23,190,6,148,247,120,234,75,0,26,197,62,94,252,219,203,117,35,11,32,57,177,33,88,237,149,56,87,174,20,125,136,171,168,68,175,74,165,71,134,139,48,27,166,77,146,158,231,83,111,229,122,60,211,133,230,220,105,92,41,55,46,245,40,244,102,143,54,65,25,63,161,1,216,80,73,209,76,132,187,208,89,18,169,200,196,135,130,116,188,159,86,164,100,109,198,173,186,3,64,52,217,226,250,124,123,5,202,38,147,118,126,255,82,85,212,207,206,59,227,47,16,58,17,182,189,28,42,223,183,170,213,119,248,152,2,44,154,163,70,221,153,101,155,167,43,172,9,129,22,39,253,19,98,108,110,79,113,224,232,178,185,112,104,218,246,97,228,251,34,242,193,238,210,144,12,191,179,162,241,81,51,145,235,249,14,239,107,49,192,214,31,181,199,106,157,184,84,204,176,115,121,50,45,127,4,150,254,138,236,205,93,222,114,67,29,24,72,243,141,128,195,78,66,215,61,156,180]);
    const perm = new Uint8Array(512), permMod12 = new Uint8Array(512);
    for (let i = 0; i < 512; i++) { perm[i] = p[i & 255]; permMod12[i] = (perm[i] % 12); }
    function grad(hash, x, y, z) {
        const h = hash & 15; const u = h < 8 ? x : y, v = h < 4 ? y : h === 12 || h === 14 ? x : z;
        return ((h & 1) === 0 ? u : -u) + ((h & 2) === 0 ? v : -v);
    }
    return function (xin, yin, zin) {
        let n0, n1, n2, n3;
        const s = (xin + yin + zin) * F3; const i = Math.floor(xin + s), j = Math.floor(yin + s), k = Math.floor(zin + s);
        const t = (i + j + k) * G3; const X0 = i - t, Y0 = j - t, Z0 = k - t;
        const x0 = xin - X0, y0 = yin - Y0, z0 = zin - Z0;
        let i1, j1, k1, i2, j2, k2;
        if (x0 >= y0) {
            if (y0 >= z0) { i1=1;j1=0;k1=0;i2=1;j2=1;k2=0; } else if (x0 >= z0) { i1=1;j1=0;k1=0;i2=1;j2=0;k2=1; } else { i1=0;j1=0;k1=1;i2=1;j2=0;k2=1; }
        } else {
            if (y0 < z0) { i1=0;j1=0;k1=1;i2=0;j2=1;k2=1; } else if (x0 < z0) { i1=0;j1=1;k1=0;i2=0;j2=1;k2=1; } else { i1=0;j1=1;k1=0;i2=1;j2=1;k2=0; }
        }
        const x1=x0-i1+G3, y1=y0-j1+G3, z1=z0-k1+G3;
        const x2=x0-i2+2.0*G3, y2=y0-j2+2.0*G3, z2=z0-k2+2.0*G3;
        const x3=x0-1.0+3.0*G3, y3=y0-1.0+3.0*G3, z3=z0-1.0+3.0*G3;
        const ii=i&255, jj=j&255, kk=k&255;
        let t0=0.6-x0*x0-y0*y0-z0*z0; if(t0<0) n0=0.0; else { t0*=t0; n0=t0*t0*grad(permMod12[ii+perm[jj+perm[kk]]],x0,y0,z0); }
        let t1=0.6-x1*x1-y1*y1-z1*z1; if(t1<0) n1=0.0; else { t1*=t1; n1=t1*t1*grad(permMod12[ii+i1+perm[jj+j1+perm[kk+k1]]],x1,y1,z1); }
        let t2=0.6-x2*x2-y2*y2-z2*z2; if(t2<0) n2=0.0; else { t2*=t2; n2=t2*t2*grad(permMod12[ii+i2+perm[jj+j2+perm[kk+k2]]],x2,y2,z2); }
        let t3=0.6-x3*x3-y3*y3-z3*z3; if(t3<0) n3=0.0; else { t3*=t3; n3=t3*t3*grad(permMod12[ii+1+perm[jj+1+perm[kk+1]]],x3,y3,z3); }
        return 32.0*(n0+n1+n2+n3);
    };
})();

function boilBuildBasePath(W, H, R) {
    const pts = []; const { divW, divH, divCorner } = BOIL_CFG;
    for (let i = 0; i < divW; i++) pts.push({ x: R + (W - 2 * R) * (i / divW), y: 0 });
    for (let i = 0; i < divCorner; i++) pts.push({ x: W - R + R * Math.cos(-Math.PI / 2 + (Math.PI / 2) * (i / divCorner)), y: R + R * Math.sin(-Math.PI / 2 + (Math.PI / 2) * (i / divCorner)) });
    for (let i = 0; i < divH; i++) pts.push({ x: W, y: R + (H - 2 * R) * (i / divH) });
    for (let i = 0; i < divCorner; i++) pts.push({ x: W - R + R * Math.cos((Math.PI / 2) * (i / divCorner)), y: H - R + R * Math.sin((Math.PI / 2) * (i / divCorner)) });
    for (let i = 0; i < divW; i++) pts.push({ x: W - R - (W - 2 * R) * (i / divW), y: H });
    for (let i = 0; i < divCorner; i++) pts.push({ x: R + R * Math.cos(Math.PI / 2 + (Math.PI / 2) * (i / divCorner)), y: H - R + R * Math.sin(Math.PI / 2 + (Math.PI / 2) * (i / divCorner)) });
    for (let i = 0; i < divH; i++) pts.push({ x: 0, y: H - R - (H - 2 * R) * (i / divH) });
    for (let i = 0; i < divCorner; i++) pts.push({ x: R + R * Math.cos(Math.PI + (Math.PI / 2) * (i / divCorner)), y: R + R * Math.sin(Math.PI + (Math.PI / 2) * (i / divCorner)) });
    return pts;
}

function boilDeformPath(base, time, seed) {
    const freq = BOIL_CFG.noiseFreq * BOIL_CFG.noiseCoordScale, t = time * BOIL_CFG.noiseTimeScale;
    return base.map(p => ({ x: p.x + Simplex3D(p.x * freq + seed, p.y * freq + seed, t) * BOIL_CFG.noiseAmp, y: p.y + Simplex3D(p.x * freq + seed + 99.9, p.y * freq + seed + 99.9, t) * BOIL_CFG.noiseAmp }));
}

function boilTraceSmoothPath(c, pts) {
    if (pts.length < 3) return;
    c.beginPath();
    let p1 = pts[0];
    c.moveTo((pts[pts.length - 1].x + p1.x) / 2, (pts[pts.length - 1].y + p1.y) / 2);
    for (let i = 0; i < pts.length; i++) {
        p1 = pts[i];
        const p2 = pts[(i + 1) % pts.length];
        c.quadraticCurveTo(p1.x, p1.y, (p1.x + p2.x) / 2, (p1.y + p2.y) / 2);
    }
    c.closePath();
}

let eraserPts = null;

function getEraserPath(W, H, P) {
    if (eraserPts) return eraserPts;
    eraserPts = [];
    const startX = -P - 80;
    const startY = -P - 80;
    const maxDim = Math.max(W, H) + P * 2 + 160;

    const basePts = [];
    const zigzags = 24;
    for (let i = 0; i <= zigzags; i++) {
        let t = i / zigzags;
        let bx = startX + t * maxDim;
        let by = startY + t * maxDim;
        let offset = (i % 2 === 0) ? 1 : -1;
        let amp = 550 + Math.random() * 50;
        if (i === 0 || i === zigzags) amp = 0;
        let px = 0.707;
        let py = -0.707;
        basePts.push({ x: bx + px * amp * offset, y: by + py * amp * offset });
    }

    const detailSteps = 8;
    let totalLength = 0;
    for (let i = 0; i < basePts.length - 1; i++) {
        let p1 = basePts[i];
        let p2 = basePts[i + 1];
        for (let j = 0; j < detailSteps; j++) {
            let t = j / detailSteps;
            let x = p1.x + (p2.x - p1.x) * t;
            let y = p1.y + (p2.y - p1.y) * t;
            x += (Math.random() - 0.5) * 15;
            y += (Math.random() - 0.5) * 15;
            let pt = { x, y };
            if (eraserPts.length > 0) {
                let lastPt = eraserPts[eraserPts.length - 1];
                totalLength += Math.hypot(x - lastPt.x, y - lastPt.y);
            }
            pt.dist = totalLength;
            eraserPts.push(pt);
        }
    }
    let lastBase = basePts[basePts.length - 1];
    totalLength += Math.hypot(lastBase.x - eraserPts[eraserPts.length - 1].x, lastBase.y - eraserPts[eraserPts.length - 1].y);
    eraserPts.push({ x: lastBase.x, y: lastBase.y, dist: totalLength });
    eraserPts.totalLength = totalLength;
    return eraserPts;
}

function initEraserMask() {
    if (document.getElementById('eraser-mask-svg')) return;
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.id = 'eraser-mask-svg';
    svg.style.position = 'absolute';
    svg.style.width = '0';
    svg.style.height = '0';
    svg.style.pointerEvents = 'none';
    svg.innerHTML = `
        <defs>
            <mask id="eraser-mask" maskUnits="userSpaceOnUse" x="-200" y="-200" width="1000" height="500">
                <rect x="-200" y="-200" width="1000" height="500" fill="white" />
                <path id="eraser-path" fill="none" stroke="black" stroke-width="160" stroke-linecap="round" stroke-linejoin="round" />
            </mask>
        </defs>
    `;
    document.body.appendChild(svg);
    const wrapper = document.querySelector('.sub-card-wrapper');
    if (wrapper) {
        wrapper.style.mask = 'url(#eraser-mask)';
        wrapper.style.webkitMask = 'url(#eraser-mask)';
    }
}

window.widgetAnimState = 'HIDDEN';
window.widgetAnimStartTime = performance.now();

window.setWidgetVisibility = function(visible) {
    if (visible && (window.widgetAnimState === 'HIDDEN' || window.widgetAnimState === 'DISAPPEARING')) {
        window.widgetAnimState = 'APPEARING';
        window.widgetAnimStartTime = performance.now();
        eraserPts = null;
        const eraserPathEl = document.getElementById('eraser-path');
        if (eraserPathEl) eraserPathEl.setAttribute('d', '');
    } else if (!visible && (window.widgetAnimState === 'VISIBLE' || window.widgetAnimState === 'APPEARING')) {
        window.widgetAnimState = 'DISAPPEARING';
        window.widgetAnimStartTime = performance.now();
    }
}

function initBoilingBorder(canvas, contentW, contentH) {
    if (!canvas) return;
    const P = BOIL_CFG.padding, R = BOIL_CFG.cornerRadius;
    const cw = contentW + P * 2, ch = contentH + P * 2;
    const dpr = (window.devicePixelRatio || 1) * scaleFactor;
    
    canvas.width = cw * dpr;
    canvas.height = ch * dpr;
    canvas.style.width = cw + 'px';
    canvas.style.height = ch + 'px';

    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);

    // ─── SKULL CANVAS SETUP ───
    let skullCanvas = document.getElementById('skullOverlayCanvas');
    if (!skullCanvas) {
        skullCanvas = document.createElement('canvas');
        skullCanvas.id = 'skullOverlayCanvas';
        skullCanvas.className = canvas.className;
        skullCanvas.style.backgroundColor = 'transparent';
        skullCanvas.style.backgroundImage = 'none';
        skullCanvas.style.boxShadow = 'none';
        skullCanvas.style.border = 'none';
        skullCanvas.style.pointerEvents = 'none'; 
        skullCanvas.style.zIndex = '100';
        canvas.parentElement.insertBefore(skullCanvas, canvas.nextSibling);
    }
    skullCanvas.width = cw * dpr;
    skullCanvas.height = ch * dpr;
    skullCanvas.style.width = cw + 'px';
    skullCanvas.style.height = ch + 'px';
    
    const skullCtx = skullCanvas.getContext('2d');
    skullCtx.scale(dpr, dpr);
    // ─────────────────────────

    const basePath = boilBuildBasePath(contentW, contentH, R);
    let seed = Math.random() * 1000;
    const contentEl = document.querySelector('.sub-card-content');
    initEraserMask();

    const STROKE_DUR = 1200;
    const FADE_DELAY = 300;
    const FADE_DUR = 500;
    const TOTAL_ANIM_DUR = Math.max(STROKE_DUR, FADE_DELAY + FADE_DUR);
    const OUTRO_DUR = 1500;

    function tick(ts) {
        let elapsed = ts - window.widgetAnimStartTime;

        // PREVENT GLITCH: Check end of disappearing animation immediately!
        if (window.widgetAnimState === 'DISAPPEARING' && elapsed >= OUTRO_DUR) {
            window.widgetAnimState = 'HIDDEN';
            seed = Math.random() * 1000;
            eraserPts = null;
        }

        // Clear slightly larger area to prevent any out-of-bound pixel artifacts from the skull
        ctx.clearRect(-50, -50, cw + 100, ch + 100);
        skullCtx.clearRect(-50, -50, cw + 100, ch + 100); 

        if (window.widgetAnimState === 'HIDDEN') {
            if (contentEl) contentEl.style.opacity = 0;
            const eraserPathEl = document.getElementById('eraser-path');
            if (eraserPathEl) eraserPathEl.setAttribute('d', ''); // Clear mask fully
            requestAnimationFrame(tick);
            return;
        }

        ctx.save();
        skullCtx.save(); // Save skull context

        ctx.translate(P, P);
        skullCtx.translate(P, P); // Translate skull context

        const deformed = boilDeformPath(basePath, ts / 1000, seed);
        ctx.lineWidth = BOIL_CFG.strokeWidth;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';

        // ── DRAW SKULL LOGIC (FIXED: Frame clamping & elapsed time) ──
        let skullAlpha = 1;
        let skullFrameIdx = SKULL_CFG.framesCount - 1; // Default to last frame

        if (window.widgetAnimState === 'APPEARING') {
            // Sync alpha with border fade
            const fadeT = Math.min(1, Math.max(0, (elapsed - FADE_DELAY) / FADE_DUR));
            skullAlpha = fadeT * fadeT * (3 - 2 * fadeT);
            
            // Calculate frame index based on ELAPSED time instead of total time, clamped to the last frame.
            skullFrameIdx = Math.min(SKULL_CFG.framesCount - 1, Math.floor((elapsed / 1000) * SKULL_CFG.fps));
        } else if (window.widgetAnimState === 'VISIBLE' || window.widgetAnimState === 'DISAPPEARING') {
            skullAlpha = 1;
            skullFrameIdx = SKULL_CFG.framesCount - 1; // Lock cleanly to final frame
        }

        const frame = skullFrames[skullFrameIdx];
        if (frame && frame.complete && skullAlpha > 0) {
            try {
                skullCtx.save();
                skullCtx.globalAlpha = skullAlpha;
                skullCtx.drawImage(
                    frame,
                    SKULL_CFG.sx, SKULL_CFG.sy, SKULL_CFG.sw, SKULL_CFG.sh,
                    SKULL_CFG.dx, SKULL_CFG.dy,
                    SKULL_CFG.sw * SKULL_CFG.scale, SKULL_CFG.sh * SKULL_CFG.scale
                );
                skullCtx.restore();
            } catch (err) {}
        }
        // ─────────────────────────────────────────────────────────────

        if (window.widgetAnimState === 'APPEARING') {
            if (elapsed >= TOTAL_ANIM_DUR) {
                window.widgetAnimState = 'VISIBLE';
                elapsed = TOTAL_ANIM_DUR;
            }
            const strokeT = Math.min(1, Math.max(0, elapsed / STROKE_DUR));
            const strokeProgress = 1 - Math.pow(1 - strokeT, 3);
            const fadeT = Math.min(1, Math.max(0, (elapsed - FADE_DELAY) / FADE_DUR));
            const smoothFade = fadeT * fadeT * (3 - 2 * fadeT);

            if (strokeProgress < 1) {
                const dashLen = 3000;
                const actualLen = 1500;
                const startOffset = dashLen + 20;
                ctx.setLineDash([dashLen, dashLen]);
                ctx.lineDashOffset = startOffset - (actualLen + 20) * strokeProgress;
            } else {
                ctx.setLineDash([]);
            }

            ctx.fillStyle = `rgba(255, 255, 255, ${smoothFade})`;
            ctx.strokeStyle = `rgba(255, 255, 255, ${smoothFade})`;
            boilTraceSmoothPath(ctx, deformed);
            ctx.fill();
            ctx.stroke();

            if (contentEl) contentEl.style.opacity = smoothFade;

            ctx.strokeStyle = '#000000';
            boilTraceSmoothPath(ctx, deformed);
            ctx.stroke();

        } else if (window.widgetAnimState === 'VISIBLE' || window.widgetAnimState === 'DISAPPEARING') {
            ctx.setLineDash([]);
            ctx.fillStyle = '#ffffff';
            ctx.strokeStyle = '#ffffff';
            boilTraceSmoothPath(ctx, deformed);
            ctx.fill();
            ctx.stroke();

            ctx.strokeStyle = '#000000';
            boilTraceSmoothPath(ctx, deformed);
            ctx.stroke();

            if (contentEl && contentEl.style.opacity !== "1") {
                contentEl.style.opacity = 1;
            }

            if (window.widgetAnimState === 'DISAPPEARING') {
                let outroP = Math.max(0, Math.min(1, elapsed / OUTRO_DUR));
                let easeP = outroP < 0.5 ? 2 * outroP * outroP : 1 - Math.pow(-2 * outroP + 2, 2) / 2;
                easeP = Math.max(0, Math.min(1, easeP));

                let pts = getEraserPath(contentW, contentH, P);
                let targetDist = easeP * pts.totalLength;
                let d = "";
                if (pts.length > 0) {
                    d += `M ${pts[0].x} ${pts[0].y}`;
                    for (let i = 1; i < pts.length; i++) {
                        if (pts[i].dist <= targetDist) {
                            d += ` L ${pts[i].x} ${pts[i].y}`;
                        } else {
                            let prev = pts[i - 1], curr = pts[i];
                            let segmentLen = curr.dist - prev.dist;
                            if (segmentLen > 0) {
                                let t = (targetDist - prev.dist) / segmentLen;
                                let x = prev.x + (curr.x - prev.x) * t;
                                let y = prev.y + (curr.y - prev.y) * t;
                                d += ` L ${x} ${y}`;
                            }
                            break;
                        }
                    }
                }

                const eraserPathEl = document.getElementById('eraser-path');
                if (eraserPathEl) {
                    eraserPathEl.setAttribute('d', d);
                    const jx = (Math.random() - 0.5) * 2;
                    const jy = (Math.random() - 0.5) * 2;
                    eraserPathEl.setAttribute('transform', `translate(${jx}, ${jy})`);
                }

                // Erase Border
                ctx.globalCompositeOperation = 'destination-out';
                ctx.lineCap = 'round';
                ctx.lineJoin = 'round';
                const p = new Path2D(d);
                const randTx = (Math.random() - 0.5) * 2;
                const randTy = (Math.random() - 0.5) * 2;

                ctx.save();
                ctx.translate(randTx, randTy);
                ctx.lineWidth = 140;
                ctx.stroke(p);
                ctx.lineWidth = 160;
                ctx.stroke(p);
                ctx.restore();
                ctx.globalCompositeOperation = 'source-over';

                // Erase Skull
                skullCtx.globalCompositeOperation = 'destination-out';
                skullCtx.lineCap = 'round';
                skullCtx.lineJoin = 'round';

                skullCtx.save();
                skullCtx.translate(randTx, randTy); // Use same jitter for coherence
                skullCtx.lineWidth = 140;
                skullCtx.stroke(p);
                skullCtx.lineWidth = 160;
                skullCtx.stroke(p);
                skullCtx.restore();
                skullCtx.globalCompositeOperation = 'source-over';
            }
        }

        ctx.restore();
        skullCtx.restore();

        requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
}

const state = {
    currentSecs: 0,
    durationSeconds: 0,
    isPlaying: false,
    lastUpdateTime: performance.now(),
    scrollStartTime: null
};

const timeCurrentEl = document.getElementById('timeCurrent');
const timeRemainingEl = document.getElementById('timeRemaining');
const progressThumbEl = document.getElementById('progressThumb');
const borderCanvasEl = document.querySelector('.sub-border-canvas');

const titleEl = document.getElementById('trackTitle');
const artistEl = document.getElementById('trackArtist');
const progressContainer = document.getElementById('progressContainer');
const progressSvg = document.getElementById('progressSvg');
const progressPath = document.getElementById('progressPath');

initBoilingBorder(borderCanvasEl, 485, 120);

let currentState = -1;
let hideDebounceTimeout = null;
let durationTimeout = null;

function ConvertSeconds(time) {
    if (!time || time < 0 || isNaN(time)) return "0:00";
    const minutes = Math.floor(time / 60);
    const seconds = Math.trunc(time - minutes * 60);
    return `${minutes}:${('0' + seconds).slice(-2)}`;
}

function SetConnectionStatus(connected) {
    let statusContainer = document.getElementById("statusContainer");
    if (!statusContainer) return;
    if (connected) {
        statusContainer.style.background = "#2FB774";
        statusContainer.innerText = "Connected!";
        statusContainer.style.opacity = 1;
        setTimeout(() => {
            statusContainer.style.transition = "all 2s ease";
            statusContainer.style.opacity = 0;
        }, 1500);
    } else {
        statusContainer.style.transition = "none";
        statusContainer.style.background = "#D12025";
        statusContainer.innerText = "Connecting...";
        statusContainer.style.opacity = 1;
        window.setWidgetVisibility(false);
    }
}

function UpdatePlayer(stateData) {
    if (!stateData || !stateData.player || !stateData.video) return;
    const songInfo = stateData.video;
    const player = stateData.player;

    state.durationSeconds = songInfo.durationSeconds || 0;
    
    const serverSecs = player.videoProgress || 0;
    const songChanged = titleEl && titleEl.innerText !== songInfo.title;
    const stateChanged = player.trackState !== currentState;
    
    let localSecs = state.currentSecs;
    if (state.isPlaying) {
        const elapsedMs = performance.now() - state.lastUpdateTime;
        localSecs += elapsedMs / 1000;
    }
    
    const drift = Math.abs(serverSecs - localSecs);
    
    if (songChanged || stateChanged || drift > 2) {
        state.currentSecs = serverSecs;
        state.lastUpdateTime = performance.now();
    }

    // Force scroll timer to restart when a new song begins
    if (songChanged) {
        state.scrollStartTime = null; 
    }

    if (songInfo.thumbnails && songInfo.thumbnails.length > 0) {
        const thumbnail = songInfo.thumbnails[songInfo.thumbnails.length - 1].url;
        const albumArtEl = document.getElementById("albumArt");
        if (albumArtEl && albumArtEl.src !== thumbnail) albumArtEl.src = thumbnail;
    }

    if (titleEl && titleEl.innerText !== songInfo.title) titleEl.innerText = songInfo.title;
    if (artistEl && artistEl.innerText !== songInfo.author) artistEl.innerText = songInfo.author;

    if (player.trackState !== currentState) {
        clearTimeout(hideDebounceTimeout);
        clearTimeout(durationTimeout);
 
        if (player.trackState === 1 || player.trackState === 2) {
            // 1 = playing, 2 = buffering while a track loads (e.g. when you skip
            // or a new song starts right after another). Keep the widget visible
            // for both so track changes stay seamless and the intro animation
            // never replays mid-skip.
            window.setWidgetVisibility(true);
            state.isPlaying = (player.trackState === 1);

            if (player.trackState === 1 && visibilityDuration > 0) {
                durationTimeout = setTimeout(() => {
                    window.setWidgetVisibility(false);
                }, visibilityDuration * 1000);
            }
        } else {
            // Genuinely paused/stopped: run the outro after a short debounce so
            // it reacts promptly instead of waiting a long time.
            state.isPlaying = false;
            hideDebounceTimeout = setTimeout(() => {
                window.setWidgetVisibility(false);
            }, 400);
        }
        currentState = player.trackState;
    }
}

function connectws() {
    if (typeof io === 'undefined') return setTimeout(connectws, 1000);

    const socket = io("http://localhost:9863/api/v1/realtime", {
        transports: ['websocket'],
        auth: { token: token }
    });

    socket.on("state-update", (stateData) => {
        UpdatePlayer(stateData);
    });

    socket.on('connect', function () {
        SetConnectionStatus(true);
    });

    socket.on('disconnect', function () {
        SetConnectionStatus(false);
        setTimeout(connectws, 5000);
    });
}

function getScrollOffset(overflow, syncOverflow, timeMs) {
    if (overflow <= 0) return 0;
    const speed = 40;
    const scrollDur = (syncOverflow / speed) * 1000;
    const myScrollDur = (overflow / speed) * 1000;
    const pauseStart = 6000;
    const pauseEnd = 6000;
    const totalCycle = pauseStart + scrollDur + pauseEnd;

    const t = timeMs % totalCycle;
    let offsetX = 0;

    if (t < pauseStart) offsetX = 0;
    else if (t >= pauseStart + scrollDur) offsetX = -overflow;
    else {
        const scrollTime = t - pauseStart;
        if (scrollTime >= myScrollDur) offsetX = -overflow;
        else {
            const p = scrollTime / myScrollDur;
            const ease = -(Math.cos(Math.PI * p) - 1) / 2;
            offsetX = -(ease * overflow);
        }
    }
    return offsetX;
}

function updateUI(ts) {
    if (state.scrollStartTime === null) state.scrollStartTime = ts;
    const timeMs = ts - state.scrollStartTime;

    if (titleEl && artistEl) {
        const titleOverflow = Math.max(0, titleEl.scrollWidth - titleEl.parentElement.clientWidth);
        const artistOverflow = Math.max(0, artistEl.scrollWidth - artistEl.parentElement.clientWidth);
        const globalMaxOverflow = Math.max(titleOverflow, artistOverflow);

        titleEl.style.transform = `translateX(${getScrollOffset(titleOverflow, globalMaxOverflow, timeMs)}px)`;
        artistEl.style.transform = `translateX(${getScrollOffset(artistOverflow, globalMaxOverflow, timeMs)}px)`;
    }

    let currentSecs = state.currentSecs;
    if (state.isPlaying && state.durationSeconds > 0) {
        const elapsedMs = performance.now() - state.lastUpdateTime;
        currentSecs += elapsedMs / 1000;
    }
    currentSecs = Math.max(0, Math.min(state.durationSeconds, currentSecs));
    
    const remainingSecs = Math.max(0, state.durationSeconds - currentSecs);
    const smoothProgress = state.durationSeconds > 0 ? (currentSecs / state.durationSeconds) : 0;

    if (timeCurrentEl) timeCurrentEl.innerText = ConvertSeconds(currentSecs);
    if (timeRemainingEl) {
        if (state.durationSeconds > 0) timeRemainingEl.innerText = "-" + ConvertSeconds(remainingSecs);
        else timeRemainingEl.innerText = "-0:00";
    }

    if (progressContainer && progressThumbEl && progressSvg && progressPath) {
        const containerW = progressContainer.clientWidth;
        const thumbX = smoothProgress * containerW;

        progressThumbEl.style.left = thumbX + 'px';
        progressSvg.style.width = Math.max(0, thumbX + 10) + 'px';

        let d = "";
        if (thumbX > 0) {
            const segments = Math.max(10, Math.floor(thumbX / 2));
            for (let i = 0; i <= segments; i++) {
                const px = (i / segments) * thumbX;
                const py = 12 + Math.sin((px * 0.15) + (timeMs * 0.004)) * 1.5;
                if (i === 0) d += `M ${px} ${py}`;
                else d += ` L ${px} ${py}`;
            }
        } else {
            d = "M 0 12";
        }
        progressPath.setAttribute('d', d);
    }
    requestAnimationFrame(updateUI);
}
requestAnimationFrame(updateUI);