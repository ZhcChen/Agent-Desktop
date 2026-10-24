/**
 * 生成 Agent Desktop 的 logo 资产。
 *
 * 设计（1024×1024 画布）：
 * - 圆角方形底板（超椭圆 squircle，macOS 风格）：桌面窗口隐喻
 * - 终端提示符 `>`：与 agent 交互
 * - 三条递减的输出条：多 agent 集合；最后一条是蓝色光标块（正在输出）
 *
 * 蓝色只用于提示符与光标，保证唯一视觉焦点，16px 下依然可辨。
 *
 * 产物：
 *   assets/logo.svg            矢量母版
 *   assets/logo-<size>.png     各尺寸位图
 *   resources/icon.png         1024×1024（electron-builder 用）
 *   resources/icon.icns        macOS 图标
 *
 * 注：图标放在 resources/ 而不是 build/ —— build/ 是构建产物目录（已被 git 忽略），
 * 而图标属于需要进版本库的源资源。
 */
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const assetsDir = join(root, 'assets');
const resourcesDir = join(root, 'resources');

/** 超椭圆（squircle）路径：|x/a|^n + |y/a|^n = 1，n=5 接近 macOS 观感。 */
function squirclePath(cx, cy, a, n = 5, steps = 240) {
  const points = [];
  for (let i = 0; i < steps; i += 1) {
    const t = (i / steps) * Math.PI * 2;
    const cos = Math.cos(t);
    const sin = Math.sin(t);
    const x = cx + a * Math.sign(cos) * Math.abs(cos) ** (2 / n);
    const y = cy + a * Math.sign(sin) * Math.abs(sin) ** (2 / n);
    points.push([x, y]);
  }
  const d = points
    .map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(2)} ${y.toFixed(2)}`)
    .join(' ');
  return `${d} Z`;
}

const squircle = squirclePath(512, 512, 448);

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024" role="img" aria-label="Agent Desktop">
  <defs>
    <linearGradient id="plate" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#222C3F"/>
      <stop offset="0.55" stop-color="#141A25"/>
      <stop offset="1" stop-color="#090C12"/>
    </linearGradient>
    <radialGradient id="glow" cx="0.3" cy="0.22" r="0.75">
      <stop offset="0" stop-color="#5B9BFF" stop-opacity="0.16"/>
      <stop offset="1" stop-color="#5B9BFF" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="accent" x1="0" y1="0" x2="0.6" y2="1">
      <stop offset="0" stop-color="#7FB4FF"/>
      <stop offset="1" stop-color="#3B7BFF"/>
    </linearGradient>
    <clipPath id="plateClip">
      <path d="${squircle}"/>
    </clipPath>
  </defs>

  <path d="${squircle}" fill="url(#plate)"/>
  <g clip-path="url(#plateClip)">
    <rect x="64" y="64" width="896" height="896" fill="url(#glow)"/>
  </g>
  <path d="${squircle}" fill="none" stroke="#FFFFFF" stroke-opacity="0.09" stroke-width="8"/>

  <!-- 终端提示符 -->
  <path d="M 264 372 L 392 512 L 264 652" fill="none" stroke="url(#accent)"
        stroke-width="78" stroke-linecap="round" stroke-linejoin="round"/>

  <!-- 多 agent 输出条 -->
  <rect x="468" y="372" width="290" height="52" rx="26" fill="#5F6E8A"/>
  <rect x="468" y="486" width="164" height="52" rx="26" fill="#5F6E8A"/>
  <rect x="468" y="600" width="66" height="52" rx="14" fill="url(#accent)"/>
</svg>
`;

mkdirSync(assetsDir, { recursive: true });
mkdirSync(resourcesDir, { recursive: true });
writeFileSync(join(assetsDir, 'logo.svg'), svg, 'utf8');

/** 光栅化到 PNG。 */
function render(size) {
  const resvg = new Resvg(svg, {
    fitTo: { mode: 'width', value: size },
    background: 'rgba(0,0,0,0)',
  });
  return resvg.render().asPng();
}

const sizes = [1024, 512, 256, 128, 64, 32, 16];
for (const size of sizes) {
  writeFileSync(join(assetsDir, `logo-${size}.png`), render(size));
}
writeFileSync(join(resourcesDir, 'icon.png'), render(1024));

// macOS .icns：iconutil 需要 .iconset 目录（按尺寸命名）。中间产物走临时目录。
// 注意：目录名必须以 .iconset 结尾，iconutil 会校验扩展名。
const iconset = join(tmpdir(), `agent-desktop-${Date.now()}.iconset`);
if (existsSync(iconset)) rmSync(iconset, { recursive: true, force: true });
mkdirSync(iconset, { recursive: true });
const iconsetEntries = [
  ['icon_16x16.png', 16],
  ['icon_16x16@2x.png', 32],
  ['icon_32x32.png', 32],
  ['icon_32x32@2x.png', 64],
  ['icon_128x128.png', 128],
  ['icon_128x128@2x.png', 256],
  ['icon_256x256.png', 256],
  ['icon_256x256@2x.png', 512],
  ['icon_512x512.png', 512],
  ['icon_512x512@2x.png', 1024],
];
for (const [name, size] of iconsetEntries) {
  writeFileSync(join(iconset, name), render(size));
}

console.log('已生成：');
console.log('  assets/logo.svg');
for (const size of sizes) console.log(`  assets/logo-${size}.png`);
console.log('  resources/icon.png');

// macOS 上直接把 .iconset 打成 .icns；其他平台跳过（electron-builder 会自行转换）。
if (process.platform === 'darwin') {
  const { execFileSync } = await import('node:child_process');
  try {
    execFileSync('iconutil', ['-c', 'icns', iconset, '-o', join(resourcesDir, 'icon.icns')], { stdio: 'pipe' });
    console.log('  resources/icon.icns');
  } catch (error) {
    console.warn(`iconutil 打包失败（可手动执行）：${error instanceof Error ? error.message : String(error)}`);
  }
} else {
  console.log(`  ${iconset}/（非 macOS：electron-builder 会自行转换）`);
}
