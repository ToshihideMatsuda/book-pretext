// Text-based pinball game

const canvas = document.getElementById('canvas') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;

// Field dimensions
const FW = 360;   // field width
const FH = 580;   // field height
canvas.width = FW;
canvas.height = FH;

// Scale canvas for device pixel ratio
const DPR = Math.min(window.devicePixelRatio || 1, 2);
canvas.style.width = FW + 'px';
canvas.style.height = FH + 'px';
canvas.width = FW * DPR;
canvas.height = FH * DPR;
ctx.scale(DPR, DPR);

const FONT_SIZE = 14;
const MONO = `bold ${FONT_SIZE}px "Courier New", monospace`;
ctx.font = MONO;

// --- Colors ---
const C_BG     = '#07070a';
const C_WALL   = '#4a6080';
const C_BALL   = '#f5e8c0';
const C_BUMPER = '#d4a830';
const C_BUMP_HIT = '#ffdd55';
const C_FLIP   = '#8ab0d0';
const C_FLIP_ACT = '#c8e0ff';
const C_SCORE  = '#e8e4dc';
const C_DIM    = '#444860';
const C_DRAIN  = '#602020';
const C_LABEL  = '#707898';

// --- Field geometry ---
const WL = 30;   // left wall x
const WR = FW - 30;  // right wall x
const WT = 70;   // top wall y
const DRAIN_Y = FH - 20; // drain line

// Flipper geometry
const FL_Y = FH - 60;
const FL_LX = WL + 10;      // left flipper pivot
const FL_RX = WR - 10;      // right flipper pivot
const FL_LEN = 70;

const FL_REST_L = Math.PI / 5;      // rest: angled down
const FL_REST_R = Math.PI - Math.PI / 5;
const FL_ACT_L  = -Math.PI / 5;    // activated: angled up
const FL_ACT_R  = Math.PI + Math.PI / 5;
const FL_SPEED  = 0.28;

// --- Game state ---
interface Bumper { x: number; y: number; r: number; lit: number; pts: number; }

const BUMPERS: Bumper[] = [
  { x: 120, y: 160, r: 22, lit: 0, pts: 100 },
  { x: 240, y: 145, r: 22, lit: 0, pts: 100 },
  { x: 180, y: 230, r: 22, lit: 0, pts: 150 },
  { x: 100, y: 290, r: 18, lit: 0, pts: 200 },
  { x: 260, y: 290, r: 18, lit: 0, pts: 200 },
];

// Slingshots (angled bumpers on sides)
interface Sling { x1: number; y1: number; x2: number; y2: number; lit: number; }
const SLINGS: Sling[] = [
  { x1: WL + 4, y1: 380, x2: WL + 50, y2: 440, lit: 0 },  // left
  { x1: WR - 4, y1: 380, x2: WR - 50, y2: 440, lit: 0 },  // right
];

let score = 0;
let lives = 3;
let gameOver = false;
let paused = false;

// Ball
let bx = FW / 2, by = WT + 40;
let vx = 1.5, vy = 0;
const GRAV = 0.18;
const BR = 7;  // ball radius

// Flipper angles
let lAngle = FL_REST_L;
let rAngle = FL_REST_R;
let lActive = false;
let rActive = false;

// --- Input ---
const keys: Record<string, boolean> = {};
window.addEventListener('keydown', e => {
  keys[e.code] = true;
  if (e.code === 'KeyP') paused = !paused;
  if (gameOver && e.code === 'Space') restartGame();
  if (e.code === 'Space' && !gameOver) launchBall();
});
window.addEventListener('keyup', e => { keys[e.code] = false; });

// Touch support for mobile
let touchL = false, touchR = false;
canvas.addEventListener('touchstart', e => {
  e.preventDefault();
  for (const t of Array.from(e.changedTouches)) {
    if (t.clientX < FW / 2) touchL = true;
    else touchR = true;
  }
}, { passive: false });
canvas.addEventListener('touchend', e => {
  e.preventDefault();
  touchL = false; touchR = false;
  for (const t of Array.from(e.changedTouches)) {
    if (t.clientX < FW / 2) touchL = false;
    else touchR = false;
  }
}, { passive: false });

// --- Ball launch ---
let ballReady = true;

function launchBall() {
  if (!ballReady) return;
  ballReady = false;
  vx = (Math.random() - 0.5) * 3;
  vy = -8;
}

function resetBall() {
  bx = FW / 2;
  by = FL_Y - 20;
  vx = 0;
  vy = 0;
  ballReady = true;
}

function restartGame() {
  score = 0;
  lives = 3;
  gameOver = false;
  resetBall();
}

// --- Math helpers ---
function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}

// Reflect velocity off a normal
function reflect(nvx: number, nvy: number, speed_mult = 1.0): void {
  const dot = vx * nvx + vy * nvy;
  vx = (vx - 2 * dot * nvx) * speed_mult;
  vy = (vy - 2 * dot * nvy) * speed_mult;
}

// Distance from point to line segment, returns closest point
function distPointSeg(
  px: number, py: number,
  ax: number, ay: number,
  bx2: number, by2: number
): { dist: number; nx: number; ny: number; t: number } {
  const dx = bx2 - ax, dy = by2 - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : clamp(((px - ax) * dx + (py - ay) * dy) / len2, 0, 1);
  const cx = ax + t * dx, cy = ay + t * dy;
  const ex = px - cx, ey = py - cy;
  const dist = Math.sqrt(ex * ex + ey * ey);
  return { dist, nx: dist > 0 ? ex / dist : 0, ny: dist > 0 ? ey / dist : -1, t };
}

// --- Flipper endpoints ---
function flipEndL() {
  return { x: FL_LX + Math.cos(lAngle) * FL_LEN, y: FL_Y + Math.sin(lAngle) * FL_LEN };
}
function flipEndR() {
  return { x: FL_RX + Math.cos(rAngle) * FL_LEN, y: FL_Y + Math.sin(rAngle) * FL_LEN };
}

// --- Scoring ---
function addScore(pts: number) {
  score += pts;
}

// --- Floating score texts ---
interface FloatText { x: number; y: number; txt: string; alpha: number; }
const floats: FloatText[] = [];

function spawnFloat(x: number, y: number, txt: string) {
  floats.push({ x, y, txt, alpha: 1.0 });
}

// --- Update ---
function update() {
  if (paused || gameOver) return;

  // Flipper angles
  const lTarget = (lActive || keys['KeyZ'] || keys['ShiftLeft'] || keys['ArrowLeft'] || touchL)
    ? FL_ACT_L : FL_REST_L;
  const rTarget = (rActive || keys['KeyX'] || keys['ShiftRight'] || keys['ArrowRight'] || touchR)
    ? FL_ACT_R : FL_REST_R;

  const da = FL_SPEED;
  lAngle += clamp(lTarget - lAngle, -da, da);
  rAngle += clamp(rTarget - rAngle, -da, da);

  if (ballReady) return;

  // Gravity
  vy += GRAV;

  // Move ball
  bx += vx;
  by += vy;

  // --- Wall collisions ---
  // Left wall
  if (bx - BR < WL) {
    bx = WL + BR;
    vx = Math.abs(vx) * 0.9;
  }
  // Right wall
  if (bx + BR > WR) {
    bx = WR - BR;
    vx = -Math.abs(vx) * 0.9;
  }
  // Top wall
  if (by - BR < WT) {
    by = WT + BR;
    vy = Math.abs(vy) * 0.85;
  }

  // --- Bumper collisions ---
  for (const b of BUMPERS) {
    const dx = bx - b.x, dy = by - b.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < BR + b.r) {
      const nx = dx / dist, ny = dy / dist;
      bx = b.x + nx * (BR + b.r + 1);
      by = b.y + ny * (BR + b.r + 1);
      const speed = Math.sqrt(vx * vx + vy * vy);
      vx = nx * Math.max(speed, 5);
      vy = ny * Math.max(speed, 5);
      b.lit = 12;
      addScore(b.pts);
      spawnFloat(b.x, b.y - b.r - 8, '+' + b.pts);
    }
  }

  // --- Slingshot collisions ---
  for (const s of SLINGS) {
    const { dist, nx, ny } = distPointSeg(bx, by, s.x1, s.y1, s.x2, s.y2);
    if (dist < BR + 3) {
      // push out
      bx += nx * (BR + 3 - dist + 1);
      by += ny * (BR + 3 - dist + 1);
      reflect(nx, ny, 1.1);
      s.lit = 8;
      addScore(50);
    }
  }

  // --- Flipper collisions ---
  const endL = flipEndL();
  const endR = flipEndR();

  // Left flipper
  {
    const { dist, nx, ny, t } = distPointSeg(bx, by, FL_LX, FL_Y, endL.x, endL.y);
    if (dist < BR + 2) {
      bx += nx * (BR + 2 - dist + 1);
      by += ny * (BR + 2 - dist + 1);
      const flipSpeed = lActive || keys['KeyZ'] || keys['ShiftLeft'] || keys['ArrowLeft'] ? 1.3 : 1.0;
      reflect(nx, ny, flipSpeed);
      if (vy > 0) vy = -Math.abs(vy);
    }
  }

  // Right flipper
  {
    const { dist, nx, ny } = distPointSeg(bx, by, FL_RX, FL_Y, endR.x, endR.y);
    if (dist < BR + 2) {
      bx += nx * (BR + 2 - dist + 1);
      by += ny * (BR + 2 - dist + 1);
      const flipSpeed = rActive || keys['KeyX'] || keys['ShiftRight'] || keys['ArrowRight'] ? 1.3 : 1.0;
      reflect(nx, ny, flipSpeed);
      if (vy > 0) vy = -Math.abs(vy);
    }
  }

  // Speed cap
  const spd = Math.sqrt(vx * vx + vy * vy);
  if (spd > 14) { vx = vx / spd * 14; vy = vy / spd * 14; }

  // --- Drain ---
  if (by > DRAIN_Y + BR) {
    lives--;
    if (lives <= 0) {
      lives = 0;
      gameOver = true;
    } else {
      resetBall();
    }
  }

  // Update bumper lit
  for (const b of BUMPERS) if (b.lit > 0) b.lit--;
  for (const s of SLINGS) if (s.lit > 0) s.lit--;

  // Update floating texts
  for (const f of floats) { f.y -= 0.6; f.alpha -= 0.025; }
  floats.splice(0, floats.length, ...floats.filter(f => f.alpha > 0));
}

// --- Draw helpers ---
function drawChar(ch: string, x: number, y: number, color: string, size = FONT_SIZE) {
  ctx.font = `bold ${size}px "Courier New", monospace`;
  ctx.fillStyle = color;
  ctx.fillText(ch, x, y);
}

function drawText(txt: string, x: number, y: number, color: string, size = FONT_SIZE, align: CanvasTextAlign = 'left') {
  ctx.font = `bold ${size}px "Courier New", monospace`;
  ctx.textAlign = align;
  ctx.fillStyle = color;
  ctx.fillText(txt, x, y);
  ctx.textAlign = 'left';
}

// Draw a line as repeated characters
function drawCharLine(
  ch: string, x1: number, y1: number, x2: number, y2: number,
  color: string, size = FONT_SIZE
) {
  const dx = x2 - x1, dy = y2 - y1;
  const len = Math.sqrt(dx * dx + dy * dy);
  const steps = Math.max(1, Math.floor(len / (size * 0.65)));
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    drawChar(ch, x1 + dx * t - size * 0.35, y1 + dy * t + size * 0.35, color, size);
  }
}

// Draw a series of │ vertically
function drawVWall(x: number, y1: number, y2: number, color: string) {
  const step = FONT_SIZE + 2;
  for (let y = y1; y <= y2; y += step) {
    drawChar('│', x - 5, y, color, FONT_SIZE + 2);
  }
}

function drawHWall(y: number, x1: number, x2: number, color: string) {
  const step = (FONT_SIZE - 2) * 0.65;
  for (let x = x1; x <= x2; x += step) {
    drawChar('─', x, y, color, FONT_SIZE);
  }
}

// --- Draw ---
function draw() {
  // Background
  ctx.fillStyle = C_BG;
  ctx.fillRect(0, 0, FW, FH);

  // Score area background
  ctx.fillStyle = '#0d0d14';
  ctx.fillRect(0, 0, FW, WT - 4);

  // Score & lives
  drawText(`SCORE`, 10, 20, C_LABEL, 11);
  drawText(`${score}`, 10, 40, C_SCORE, 18);
  drawText(`BEST`, FW / 2 - 20, 20, C_LABEL, 11, 'center');

  // Lives (draw ● for each life)
  drawText(`BALLS`, FW - 10, 20, C_LABEL, 11, 'right');
  for (let i = 0; i < 3; i++) {
    const col = i < lives ? C_BALL : C_DIM;
    drawChar('●', FW - 14 - i * 16, 42, col, 13);
  }

  // Separator
  drawHWall(WT - 4, WL, WR, C_WALL);

  // Side walls
  drawVWall(WL - 5, WT, FL_Y, C_WALL);
  drawVWall(WR + 2, WT, FL_Y, C_WALL);

  // Slingshots
  for (const s of SLINGS) {
    const col = s.lit > 0 ? '#e8a040' : C_WALL;
    drawCharLine('╲', s.x1, s.y1, s.x2, s.y2, col, 13);
  }

  // Drain zone indicator
  drawHWall(DRAIN_Y, WL, FL_LX - 5, C_DRAIN);
  drawHWall(DRAIN_Y, FL_RX + FL_LEN * Math.cos(rAngle) + 10, WR, C_DRAIN);

  // Bumpers
  for (const b of BUMPERS) {
    const lit = b.lit > 0;
    const col = lit ? C_BUMP_HIT : C_BUMPER;
    if (lit) {
      ctx.globalAlpha = 0.15;
      ctx.fillStyle = '#ffdd55';
      ctx.beginPath();
      ctx.arc(b.x, b.y, b.r + 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    }
    drawChar('◆', b.x - 9, b.y + 6, col, 18);
  }

  // Flippers
  const endL = flipEndL();
  const endR = flipEndR();
  const lCol = (keys['KeyZ'] || keys['ShiftLeft'] || keys['ArrowLeft'] || touchL) ? C_FLIP_ACT : C_FLIP;
  const rCol = (keys['KeyX'] || keys['ShiftRight'] || keys['ArrowRight'] || touchR) ? C_FLIP_ACT : C_FLIP;
  drawCharLine('═', FL_LX, FL_Y, endL.x, endL.y, lCol, 14);
  drawChar('◁', FL_LX - 8, FL_Y + 5, lCol, 13);  // pivot cap
  drawCharLine('═', FL_RX, FL_Y, endR.x, endR.y, rCol, 14);
  drawChar('▷', FL_RX - 2, FL_Y + 5, rCol, 13);   // pivot cap

  // Ball
  if (!ballReady) {
    ctx.globalAlpha = 0.25;
    ctx.fillStyle = C_BALL;
    ctx.beginPath();
    ctx.arc(bx, by, BR + 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
    drawChar('●', bx - 8, by + 6, C_BALL, 16);
  } else {
    // Ball sitting on launcher
    drawChar('●', bx - 8, by + 6, C_DIM, 16);
  }

  // Floating score texts
  for (const f of floats) {
    ctx.globalAlpha = f.alpha;
    drawText(f.txt, f.x, f.y, C_BUMP_HIT, 11, 'center');
    ctx.globalAlpha = 1;
  }

  // --- Overlays ---
  if (ballReady && !gameOver) {
    drawText('SPACE / TAP to launch', FW / 2, FH - 8, C_LABEL, 11, 'center');
  }

  if (paused) {
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(0, 0, FW, FH);
    drawText('PAUSED', FW / 2, FH / 2, C_SCORE, 24, 'center');
    drawText('P to resume', FW / 2, FH / 2 + 30, C_LABEL, 13, 'center');
  }

  if (gameOver) {
    ctx.fillStyle = 'rgba(0,0,0,0.7)';
    ctx.fillRect(0, 0, FW, FH);
    drawText('GAME OVER', FW / 2, FH / 2 - 20, '#e05050', 26, 'center');
    drawText(`SCORE  ${score}`, FW / 2, FH / 2 + 16, C_SCORE, 16, 'center');
    drawText('SPACE to restart', FW / 2, FH / 2 + 46, C_LABEL, 13, 'center');
  }

  // Controls hint (bottom left, tiny)
  if (!gameOver && !paused) {
    drawText('Z/← left  X/→ right  P pause', FW / 2, FH - 4, '#333350', 10, 'center');
  }
}

// --- Game loop ---
function loop() {
  update();
  draw();
  requestAnimationFrame(loop);
}

loop();
