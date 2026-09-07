export interface WallpaperConfig {
  enabled: boolean;
  rippleIntensity: "off" | "light" | "medium" | "strong";
  floatingAsterisks: boolean;
  cursorLightAura: boolean;
}

export function getChatAmbientScript(defaultWallpaperUri: string, initialConfig?: WallpaperConfig): string {
  const configJson = JSON.stringify(initialConfig || {
    enabled: false,
    rippleIntensity: "medium",
    floatingAsterisks: true,
    cursorLightAura: true,
  });

  return `
  (function() {
    let cfg = ${configJson};
    const defaultWpUri = "${defaultWallpaperUri}";

    const container = document.getElementById('andromity-ambient-container');
    const waterCanvas = document.getElementById('andromity-water-canvas');
    const fxCanvas = document.getElementById('andromity-fx-canvas');
    const cursorLight = document.getElementById('andromity-cursor-light');
    const ditherOverlay = document.getElementById('andromity-dither-overlay');

    if (!container || !waterCanvas || !fxCanvas) return;

    const waterCtx = waterCanvas.getContext('2d', { alpha: false, desynchronized: true });
    const fxCtx = fxCanvas.getContext('2d');

    let width = 0;
    let height = 0;
    const SIM_SCALE = 4;
    let sw = 0;
    let sh = 0;

    let buffer1 = null;
    let buffer2 = null;

    let offscreenCanvas = document.createElement('canvas');
    let offscreenCtx = offscreenCanvas.getContext('2d', { alpha: false });
    let cachedSrcPixels = null;
    let reusableImageData = null;
    let reusablePixels = null;

    let damping = 0.965;
    let rippleStrength = 180;
    function updateRippleStrength() {
      if (!cfg.enabled || cfg.rippleIntensity === 'off') {
        rippleStrength = 0;
      } else if (cfg.rippleIntensity === 'light') {
        rippleStrength = 90;
      } else if (cfg.rippleIntensity === 'strong') {
        rippleStrength = 320;
      } else {
        rippleStrength = 180;
      }
    }
    updateRippleStrength();

    // Respect OS accessibility settings (WCAG 2.1 Criterion 2.3.3)
    function checkReducedMotion() {
      try {
        if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
          cfg.rippleIntensity = 'off';
          cfg.floatingAsterisks = false;
          updateRippleStrength();
        }
      } catch (e) {}
    }
    checkReducedMotion();
    try {
      if (window.matchMedia) {
        window.matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', () => {
          checkReducedMotion();
          if (cfg.rippleIntensity === 'off' && !cfg.floatingAsterisks) sleep();
        });
      }
    } catch (e) {}

    // Active image loader
    const bgImage = new Image();
    let imgLoaded = false;

    function loadActiveImage() {
      if (imgLoaded && bgImage.src === defaultWpUri) return;
      imgLoaded = false;
      bgImage.onload = () => {
        imgLoaded = true;
        rebuildBuffers();
        wakeUp();
      };
      bgImage.onerror = () => {
        imgLoaded = false;
      };
      bgImage.src = defaultWpUri;
    }

    function rebuildBuffers() {
      width = window.innerWidth || document.documentElement.clientWidth || 400;
      height = window.innerHeight || document.documentElement.clientHeight || 600;
      if (width <= 0 || height <= 0) return;

      waterCanvas.width = width;
      waterCanvas.height = height;
      fxCanvas.width = width;
      fxCanvas.height = height;

      sw = Math.floor(width / SIM_SCALE);
      sh = Math.floor(height / SIM_SCALE);

      buffer1 = new Int16Array(sw * sh);
      buffer2 = new Int16Array(sw * sh);

      offscreenCanvas.width = width;
      offscreenCanvas.height = height;

      if (imgLoaded && bgImage.naturalWidth > 0) {
        const imgAspect = bgImage.naturalWidth / bgImage.naturalHeight;
        const screenAspect = width / height;
        let dw, dh, dx, dy;
        if (screenAspect > imgAspect) {
          dw = width;
          dh = width / imgAspect;
          dx = 0;
          dy = (height - dh) * 0.15;
        } else {
          dh = height;
          dw = height * imgAspect;
          dx = (width - dw) * 0.5;
          dy = 0;
        }
        offscreenCtx.drawImage(bgImage, dx, dy, dw, dh);
        try {
          cachedSrcPixels = offscreenCtx.getImageData(0, 0, width, height).data;
          reusableImageData = waterCtx.createImageData(width, height);
          reusablePixels = reusableImageData.data;
          for (let i = 3; i < reusablePixels.length; i += 4) {
            reusablePixels[i] = 255;
          }
        } catch (e) {
          cachedSrcPixels = null;
        }
        waterCtx.drawImage(offscreenCanvas, 0, 0);
      }
    }

    window.addEventListener('resize', () => {
      rebuildBuffers();
      wakeUp();
    });

    // Auto-sleep idle governor (0% CPU when idle)
    let isRunning = false;
    let idleCounter = 0;
    const IDLE_LIMIT_FRAMES = 80;

    function wakeUp() {
      idleCounter = 0;
      if (!cfg.enabled) return;
      if (!isRunning) {
        isRunning = true;
        requestAnimationFrame(loop);
      }
    }

    function sleep() {
      if (isRunning) {
        isRunning = false;
        if (imgLoaded && offscreenCanvas.width > 0) {
          waterCtx.drawImage(offscreenCanvas, 0, 0);
        }
      }
    }

    document.addEventListener('visibilitychange', () => {
      if (document.hidden) sleep();
      else wakeUp();
    });

    // Water ripple disturbance on mousemove
    let mouse = { x: -1000, y: -1000, prevX: -1000, prevY: -1000, isHover: false };

    function dropWater(x, y, radius, strength) {
      if (!cfg.enabled || rippleStrength <= 0 || !buffer1) return;
      const rx = Math.floor(x / SIM_SCALE);
      const ry = Math.floor(y / SIM_SCALE);
      const r = Math.floor(radius / SIM_SCALE);

      for (let j = -r; j <= r; j++) {
        for (let i = -r; i <= r; i++) {
          if (i * i + j * j <= r * r) {
            const px = rx + i;
            const py = ry + j;
            if (px >= 0 && px < sw && py >= 0 && py < sh) {
              buffer1[px + py * sw] -= strength;
            }
          }
        }
      }
      wakeUp();
    }

    window.addEventListener('mousemove', (e) => {
      if (!cfg.enabled) return;
      mouse.prevX = mouse.x;
      mouse.prevY = mouse.y;
      mouse.x = e.clientX;
      mouse.y = e.clientY;
      mouse.isHover = true;

      if (cursorLight && cfg.cursorLightAura !== false) {
        cursorLight.style.transform = 'translate3d(' + mouse.x + 'px, ' + mouse.y + 'px, 0)';
      }

      const dist = Math.hypot(mouse.x - mouse.prevX, mouse.y - mouse.prevY);
      if (dist > 3) {
        if (rippleStrength > 0) {
          dropWater(mouse.x, mouse.y, 14, rippleStrength);
        }
        if (cfg.floatingAsterisks !== false) {
          spawnCursorTrailSpark(mouse.x, mouse.y);
        }
      }
      if (rippleStrength > 0 || cfg.floatingAsterisks !== false || cfg.cursorLightAura !== false) {
        wakeUp();
      }
    }, { passive: true });

    window.addEventListener('mouseleave', () => {
      mouse.isHover = false;
      mouse.x = -1000;
      mouse.y = -1000;
      if (cursorLight) {
        cursorLight.style.transform = 'translate3d(-1000px, -1000px, 0)';
      }
    });

    window.addEventListener('click', (e) => {
      if (!cfg.enabled) return;
      dropWater(e.clientX, e.clientY, 30, rippleStrength * 2.8);
      createAsteriskBurst(e.clientX, e.clientY, 12);
      wakeUp();
    });

    // Particle memory pools (Zero GC allocation)
    const ASTERISK_SYMBOLS = ['✦', '*', '★', '✧', '•', '⋆'];
    const MAX_ASTERISKS = 50;
    const asterisks = [];
    const MAX_TRAIL_SPARKS = 35;
    const trailSparks = [];

    for (let i = 0; i < MAX_TRAIL_SPARKS; i++) {
      trailSparks.push({
        active: false,
        x: 0, y: 0,
        symbol: '✦',
        size: 7,
        vx: 0, vy: 0,
        alpha: 0,
        decay: 0.035,
        r: 9, g: 249, b: 148
      });
    }

    function spawnCursorTrailSpark(x, y) {
      for (let i = 0; i < MAX_TRAIL_SPARKS; i++) {
        const sp = trailSparks[i];
        if (!sp.active) {
          sp.active = true;
          sp.x = x + (Math.random() - 0.5) * 10;
          sp.y = y + (Math.random() - 0.5) * 10;
          sp.symbol = Math.random() < 0.6 ? '✦' : '•';
          sp.size = Math.random() * 7 + 5;
          sp.vx = (Math.random() - 0.5) * 1.4;
          sp.vy = (Math.random() - 0.5) * 1.4 - 0.4;
          sp.alpha = 1.0;
          sp.decay = Math.random() * 0.04 + 0.025;
          if (Math.random() < 0.75) {
            sp.r = 9; sp.g = 249; sp.b = 148;
          } else {
            sp.r = 253; sp.g = 224; sp.b = 71;
          }
          break;
        }
      }
    }

    const COLORS = [
      { r: 9, g: 249, b: 148 },
      { r: 253, g: 224, b: 71 },
      { r: 192, g: 132, b: 252 },
      { r: 56, g: 189, b: 248 }
    ];

    for (let i = 0; i < MAX_ASTERISKS; i++) {
      const col = COLORS[i % COLORS.length];
      asterisks.push({
        active: i < 35,
        isBurst: false,
        x: Math.random() * 1920,
        y: Math.random() * 1080,
        symbol: ASTERISK_SYMBOLS[i % ASTERISK_SYMBOLS.length],
        size: Math.random() * 11 + 9,
        baseAlpha: Math.random() * 0.45 + 0.35,
        alpha: 0.5,
        rotation: Math.random() * Math.PI * 2,
        rotSpeed: (Math.random() - 0.5) * 0.02,
        vx: (Math.random() - 0.5) * 0.3,
        vy: -Math.random() * 0.3 - 0.12,
        orbitAngle: Math.random() * Math.PI * 2,
        orbitRadius: Math.random() * 80 + 30,
        orbitSpeed: (Math.random() - 0.5) * 0.035,
        twinkleSpeed: Math.random() * 0.03 + 0.01,
        twinkleAngle: Math.random() * Math.PI * 2,
        life: 1.0,
        r: col.r, g: col.g, b: col.b
      });
    }

    function createAsteriskBurst(x, y, count = 10) {
      if (!cfg.enabled || cfg.floatingAsterisks === false) return;
      let spawned = 0;
      for (let i = 0; i < MAX_ASTERISKS && spawned < count; i++) {
        const a = asterisks[i];
        if (!a.active || !a.isBurst) {
          a.active = true;
          a.isBurst = true;
          a.x = x;
          a.y = y;
          const angle = Math.random() * Math.PI * 2;
          const spd = Math.random() * 3.5 + 1.6;
          a.vx = Math.cos(angle) * spd;
          a.vy = Math.sin(angle) * spd;
          a.life = 1.0;
          a.alpha = 1.0;
          spawned++;
        }
      }
    }

    // Render loop
    function renderRipples() {
      if (!imgLoaded || !buffer1 || !buffer2 || !cachedSrcPixels || rippleStrength <= 0) return 0;

      let maxDisturbance = 0;

      for (let y = 1; y < sh - 1; y++) {
        const row = y * sw;
        for (let x = 1; x < sw - 1; x++) {
          const idx = row + x;
          const wave = (
            buffer1[idx - 1] +
            buffer1[idx + 1] +
            buffer1[idx - sw] +
            buffer1[idx + sw]
          ) >> 1;
          const next = (wave - buffer2[idx]) * damping;
          buffer2[idx] = next;
          const absVal = Math.abs(next);
          if (absVal > maxDisturbance) maxDisturbance = absVal;
        }
      }

      const temp = buffer1;
      buffer1 = buffer2;
      buffer2 = temp;

      if (maxDisturbance < 1.5) {
        waterCtx.drawImage(offscreenCanvas, 0, 0);
        return 0;
      }

      const dest = reusablePixels;
      const src = cachedSrcPixels;

      for (let y = 0; y < height; y++) {
        const ry = (y / SIM_SCALE) | 0;
        const rowOffset = y * width * 4;
        const rRowOffset = ry * sw;

        for (let x = 0; x < width; x++) {
          const rx = (x / SIM_SCALE) | 0;
          const rIdx = rRowOffset + rx;
          const pIdx = rowOffset + (x << 2);

          if (rx > 0 && rx < sw - 1 && ry > 0 && ry < sh - 1) {
            const dx = (buffer1[rIdx - 1] - buffer1[rIdx + 1]) >> 4;
            const dy = (buffer1[rIdx - sw] - buffer1[rIdx + sw]) >> 4;

            if (dx !== 0 || dy !== 0) {
              let nx = x + dx;
              let ny = y + dy;
              if (nx < 0) nx = 0;
              else if (nx >= width) nx = width - 1;
              if (ny < 0) ny = 0;
              else if (ny >= height) ny = height - 1;

              const nIdx = (ny * width + nx) * 4;
              const sheen = (dx + dy) * 0.85;

              dest[pIdx] = Math.min(255, Math.max(0, src[nIdx] + sheen));
              dest[pIdx + 1] = Math.min(255, Math.max(0, src[nIdx + 1] + sheen));
              dest[pIdx + 2] = Math.min(255, Math.max(0, src[nIdx + 2] + sheen * 1.2));
              continue;
            }
          }

          dest[pIdx] = src[pIdx];
          dest[pIdx + 1] = src[pIdx + 1];
          dest[pIdx + 2] = src[pIdx + 2];
        }
      }

      waterCtx.putImageData(reusableImageData, 0, 0);
      return maxDisturbance;
    }

    function loop() {
      if (!isRunning || !cfg.enabled) return;

      const waveEnergy = renderRipples();

      fxCtx.clearRect(0, 0, width, height);

      let activeSparksCount = 0;
      if (cfg.floatingAsterisks !== false) {
        for (let i = 0; i < MAX_TRAIL_SPARKS; i++) {
          const sp = trailSparks[i];
          if (sp.active) {
            sp.x += sp.vx;
            sp.y += sp.vy;
            sp.alpha -= sp.decay;
            if (sp.alpha <= 0) {
              sp.active = false;
            } else {
              activeSparksCount++;
              fxCtx.save();
              fxCtx.font = sp.size + "px 'Inter', sans-serif";
              fxCtx.textAlign = 'center';
              fxCtx.textBaseline = 'middle';
              fxCtx.shadowColor = 'rgba(' + sp.r + ',' + sp.g + ',' + sp.b + ',' + sp.alpha + ')';
              fxCtx.shadowBlur = 7;
              fxCtx.fillStyle = 'rgba(' + sp.r + ',' + sp.g + ',' + sp.b + ',' + sp.alpha + ')';
              fxCtx.fillText(sp.symbol, sp.x, sp.y);
              fxCtx.restore();
            }
          }
        }

        for (let i = 0; i < asterisks.length; i++) {
          const a = asterisks[i];
          if (!a.active) continue;

          a.rotation += a.rotSpeed;
          a.twinkleAngle += a.twinkleSpeed;
          a.alpha = a.baseAlpha + Math.sin(a.twinkleAngle) * 0.22;

          if (mouse.isHover) {
            const dx = mouse.x - a.x;
            const dy = mouse.y - a.y;
            const dist = Math.hypot(dx, dy);
            const maxDist = 220;

            if (dist < maxDist && dist > 1) {
              const force = (1 - dist / maxDist);
              if (dist < 90) {
                a.orbitAngle += a.orbitSpeed;
                const targetX = mouse.x + Math.cos(a.orbitAngle) * a.orbitRadius;
                const targetY = mouse.y + Math.sin(a.orbitAngle) * a.orbitRadius;
                a.vx += (targetX - a.x) * 0.04;
                a.vy += (targetY - a.y) * 0.04;
              } else {
                a.vx += (dx / dist) * force * 1.4;
                a.vy += (dy / dist) * force * 1.4;
              }
              a.alpha = Math.min(1.0, a.alpha + 0.35);
            }
          }

          a.x += a.vx;
          a.y += a.vy;
          a.vx *= 0.94;
          a.vy *= 0.94;
          if (!a.isBurst && Math.abs(a.vy) < 0.12) a.vy = -0.2;

          if (a.isBurst) {
            a.life -= 0.02;
            a.alpha *= a.life;
            if (a.life <= 0) {
              a.isBurst = false;
              a.active = i < 35;
            }
          }

          if (a.y < -25) a.y = height + 15;
          if (a.y > height + 25) a.y = -15;
          if (a.x < -25) a.x = width + 15;
          if (a.x > width + 25) a.x = -15;

          fxCtx.save();
          fxCtx.translate(a.x, a.y);
          fxCtx.rotate(a.rotation);
          fxCtx.font = a.size + "px 'Inter', sans-serif";
          fxCtx.textAlign = 'center';
          fxCtx.textBaseline = 'middle';
          fxCtx.shadowColor = 'rgba(' + a.r + ',' + a.g + ',' + a.b + ',' + (a.alpha * 0.85) + ')';
          fxCtx.shadowBlur = a.size * 0.8;
          fxCtx.fillStyle = 'rgba(' + a.r + ',' + a.g + ',' + a.b + ',' + a.alpha + ')';
          fxCtx.fillText(a.symbol, 0, 0);
          fxCtx.restore();
        }
      }

      if (!mouse.isHover && waveEnergy < 1.0 && activeSparksCount === 0) {
        idleCounter++;
        if (idleCounter > IDLE_LIMIT_FRAMES) {
          sleep();
          return;
        }
      } else {
        idleCounter = 0;
      }

      requestAnimationFrame(loop);
    }

    // Apply configuration changes dynamically
    function applyConfig(newCfg) {
      cfg = Object.assign({}, cfg, newCfg);
      checkReducedMotion();
      if (!cfg.enabled) {
        container.style.display = 'none';
        sleep();
        return;
      }
      container.style.display = 'block';
      updateRippleStrength();
      if (cursorLight) {
        cursorLight.style.display = (cfg.cursorLightAura !== false) ? 'block' : 'none';
      }
      if (!imgLoaded) {
        loadActiveImage();
      }
    }

    // Listen for configuration updates from VS Code extension
    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (msg && (msg.type === 'wallpaper_config_changed' || msg.type === 'init_state') && msg.wallpaper) {
        applyConfig(msg.wallpaper);
      }
    });

    // Initialize
    applyConfig(cfg);
  })();
  `;
}
