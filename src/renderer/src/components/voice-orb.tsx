import { useEffect, useRef, useState } from "react";

export type VoiceOrbState =
  | "idle"
  | "connecting"
  | "thinking"
  | "speaking"
  | "error";

interface VoiceOrbProps {
  state?: VoiceOrbState;
  size?: number;
  colorFrom: string;
  colorTo: string;
  label?: string;
}

type Rgb = [number, number, number];

const FLOW_RATE: Record<VoiceOrbState, number> = {
  idle: 0.22,
  connecting: 0.55,
  thinking: 0.46,
  speaking: 1.35,
  error: 0.4,
};

const VERTEX_SHADER = `
attribute vec2 aPosition;

void main() {
  gl_Position = vec4(aPosition, 0.0, 1.0);
}
`;

// Adapted from VoiceOrbs' MIT-licensed Iridescent Flow component.
const FRAGMENT_SHADER = `
precision highp float;

uniform float uSize;
uniform float uTime;
uniform float uFlow;
uniform float uLevel;
uniform vec3 uColorFrom;
uniform vec3 uColorTo;
uniform float uConnect;
uniform float uThink;
uniform float uSpeak;
uniform float uError;

float hash(vec2 point) {
  return fract(sin(dot(point, vec2(127.1, 311.7))) * 43758.5453123);
}

float noise(vec2 point) {
  vec2 cell = floor(point);
  vec2 position = fract(point);
  vec2 curve = position * position * (3.0 - 2.0 * position);
  float a = hash(cell);
  float b = hash(cell + vec2(1.0, 0.0));
  float c = hash(cell + vec2(0.0, 1.0));
  float d = hash(cell + vec2(1.0, 1.0));
  return mix(mix(a, b, curve.x), mix(c, d, curve.x), curve.y);
}

float fbm(vec2 point) {
  float value = 0.0;
  float amplitude = 0.55;
  for (int index = 0; index < 3; index++) {
    value += amplitude * noise(point);
    point = point * 2.03 + vec2(11.7, 5.3);
    amplitude *= 0.5;
  }
  return value;
}

void main() {
  vec2 point = (gl_FragCoord.xy * 2.0 - uSize) / uSize;
  float radius = length(point);
  float mask = 1.0 - smoothstep(0.86, 0.92, radius);
  if (mask < 0.003) {
    gl_FragColor = vec4(0.0);
    return;
  }

  vec2 drift = vec2(uFlow * 0.32, -uFlow * 0.21);
  vec2 warp = vec2(
    fbm(point * 2.1 + drift),
    fbm(point * 2.1 + drift.yx + vec2(4.7, 1.9))
  );
  float field = fbm(point * 2.6 + 2.2 * warp + vec2(uFlow * 0.42, uFlow * 0.27));
  float interference = sin(radius * 24.0 - uTime * 3.1) * sin(radius * 15.0 + uTime * 2.3);
  field += uThink * interference * (0.14 + 0.12 * uLevel);
  field = clamp(field, 0.0, 1.0);

  float fresnel = pow(smoothstep(0.3, 0.9, radius), 2.0);
  float phase = field * 1.7 + fresnel * 1.15 + uFlow * 0.1;
  vec3 film = 0.5 + 0.5 * cos(6.28318 * (phase + vec3(0.0, 0.33, 0.67)));
  vec3 base = mix(uColorFrom, uColorTo, smoothstep(0.15, 0.85, field));
  float iridescence = clamp(0.4 + 0.35 * uSpeak + 0.3 * uLevel, 0.0, 1.0);
  iridescence *= 1.0 - 0.75 * uError;

  vec3 color = base * (0.62 + 0.85 * field);
  color += mix(uColorFrom, uColorTo, 0.5) * (1.0 - smoothstep(0.05, 0.75, radius)) * 0.3;
  color += film * iridescence * (0.35 + 0.65 * fresnel);

  float angle = atan(point.y, point.x);
  float sweep = pow(0.5 + 0.5 * cos(angle - uTime * 2.4), 10.0);
  color += mix(uColorTo, vec3(1.0), 0.55) * sweep * smoothstep(0.35, 0.85, radius) * uConnect * 1.1;
  color *= 1.0 + uThink * (0.12 * sin(uTime * 4.2) + 0.1 * interference);

  vec3 rim = mix(uColorTo, vec3(1.0), 0.45);
  color += rim * pow(smoothstep(0.55, 0.9, radius), 3.0) * (0.4 + 0.55 * uLevel);
  color += vec3(0.98, 0.28, 0.35) * fresnel * uError * 0.35;
  color *= 0.9 + 0.45 * uLevel + 0.25 * uSpeak * uLevel;

  color = clamp(color / (1.0 + 0.22 * color), 0.0, 1.0);
  gl_FragColor = vec4(color * mask, mask);
}
`;

function hexToRgb(color: string): Rgb {
  const value = color.startsWith("#") ? color.slice(1) : color;
  const expanded = value.length === 3
    ? value.split("").map((character) => character + character).join("")
    : value;
  const parsed = Number.parseInt(expanded, 16);
  if (!Number.isFinite(parsed) || expanded.length !== 6) return [1, 1, 1];
  return [
    ((parsed >> 16) & 255) / 255,
    ((parsed >> 8) & 255) / 255,
    (parsed & 255) / 255,
  ];
}

function approach(current: number, target: number, rate: number, seconds: number): number {
  return current + (target - current) * (1 - Math.exp(-rate * seconds));
}

function proceduralLevel(state: VoiceOrbState, elapsed: number): number {
  const wave = 0.5 + 0.5 * Math.sin(elapsed * 4.2);
  if (state === "speaking") return 0.38 + wave * 0.42;
  if (state === "thinking" || state === "connecting") return 0.12 + wave * 0.18;
  if (state === "error") return 0.24 + wave * 0.16;
  return 0.08 + wave * 0.08;
}

export function VoiceOrb({
  state = "idle",
  size = 168,
  colorFrom,
  colorTo,
  label = "Voice preview orb",
}: VoiceOrbProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stateRef = useRef(state);
  const colorsRef = useRef({ colorFrom, colorTo });
  const redrawRef = useRef<(() => void) | null>(null);
  const [fallback, setFallback] = useState(false);

  useEffect(() => {
    stateRef.current = state;
    colorsRef.current = { colorFrom, colorTo };
    redrawRef.current?.();
  });

  useEffect(() => {
    const host = hostRef.current;
    const canvas = canvasRef.current;
    if (!host || !canvas) return;

    const gl = canvas.getContext("webgl", {
      alpha: true,
      antialias: false,
      premultipliedAlpha: true,
      powerPreference: "low-power",
    });
    if (!gl) {
      setFallback(true);
      return;
    }

    const compile = (type: number, source: string) => {
      const shader = gl.createShader(type);
      if (!shader) return null;
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        gl.deleteShader(shader);
        return null;
      }
      return shader;
    };

    const vertex = compile(gl.VERTEX_SHADER, VERTEX_SHADER);
    const fragment = compile(gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
    const program = gl.createProgram();
    if (!vertex || !fragment || !program) {
      if (vertex) gl.deleteShader(vertex);
      if (fragment) gl.deleteShader(fragment);
      if (program) gl.deleteProgram(program);
      setFallback(true);
      return;
    }

    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      gl.deleteShader(vertex);
      gl.deleteShader(fragment);
      gl.deleteProgram(program);
      setFallback(true);
      return;
    }
    gl.useProgram(program);

    const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    const pixels = Math.max(1, Math.round(size * pixelRatio));
    canvas.width = pixels;
    canvas.height = pixels;
    gl.viewport(0, 0, pixels, pixels);

    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const position = gl.getAttribLocation(program, "aPosition");
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);

    const uniforms = {
      size: gl.getUniformLocation(program, "uSize"),
      time: gl.getUniformLocation(program, "uTime"),
      flow: gl.getUniformLocation(program, "uFlow"),
      level: gl.getUniformLocation(program, "uLevel"),
      colorFrom: gl.getUniformLocation(program, "uColorFrom"),
      colorTo: gl.getUniformLocation(program, "uColorTo"),
      connect: gl.getUniformLocation(program, "uConnect"),
      think: gl.getUniformLocation(program, "uThink"),
      speak: gl.getUniformLocation(program, "uSpeak"),
      error: gl.getUniformLocation(program, "uError"),
    };
    gl.uniform1f(uniforms.size, pixels);

    let animationFrame = 0;
    let previousFrame: number | null = null;
    let elapsed = 0;
    let flow = 0;
    let level = 0;
    let running = false;
    let inView = true;

    const render = (seconds: number, staticFrame = false) => {
      const currentState = stateRef.current;
      const targetLevel = proceduralLevel(currentState, elapsed);
      level = approach(level, targetLevel, 8, staticFrame ? 0.06 : seconds);
      flow += seconds * FLOW_RATE[currentState];
      const from = hexToRgb(colorsRef.current.colorFrom);
      const to = hexToRgb(colorsRef.current.colorTo);

      gl.uniform1f(uniforms.time, elapsed);
      gl.uniform1f(uniforms.flow, flow);
      gl.uniform1f(uniforms.level, level);
      gl.uniform3f(uniforms.colorFrom, from[0], from[1], from[2]);
      gl.uniform3f(uniforms.colorTo, to[0], to[1], to[2]);
      gl.uniform1f(uniforms.connect, currentState === "connecting" ? 1 : 0);
      gl.uniform1f(uniforms.think, currentState === "thinking" ? 1 : 0);
      gl.uniform1f(uniforms.speak, currentState === "speaking" ? 1 : 0);
      gl.uniform1f(uniforms.error, currentState === "error" ? 1 : 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };

    const frame = (now: number) => {
      if (previousFrame === null) previousFrame = now;
      const seconds = Math.min((now - previousFrame) / 1000, 0.1);
      previousFrame = now;
      elapsed += seconds;
      render(seconds);
      animationFrame = requestAnimationFrame(frame);
    };

    const stop = () => {
      running = false;
      cancelAnimationFrame(animationFrame);
    };
    const start = () => {
      if (running) return;
      running = true;
      previousFrame = null;
      animationFrame = requestAnimationFrame(frame);
    };
    const renderStatic = () => {
      if (elapsed === 0) elapsed = 4.7;
      render(0, true);
    };

    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const applyMotionPreference = () => {
      if (reducedMotion.matches || !inView || document.hidden) {
        stop();
        if (reducedMotion.matches) renderStatic();
      } else {
        start();
      }
    };

    const observer = new IntersectionObserver(([entry]) => {
      inView = entry?.isIntersecting ?? true;
      applyMotionPreference();
    });
    const handleVisibility = () => applyMotionPreference();
    const handleContextLost = (event: Event) => {
      event.preventDefault();
      stop();
      setFallback(true);
    };

    observer.observe(host);
    reducedMotion.addEventListener("change", applyMotionPreference);
    document.addEventListener("visibilitychange", handleVisibility);
    canvas.addEventListener("webglcontextlost", handleContextLost);
    redrawRef.current = () => {
      if (!running) renderStatic();
    };
    applyMotionPreference();

    return () => {
      stop();
      observer.disconnect();
      reducedMotion.removeEventListener("change", applyMotionPreference);
      document.removeEventListener("visibilitychange", handleVisibility);
      canvas.removeEventListener("webglcontextlost", handleContextLost);
      redrawRef.current = null;
      if (buffer) gl.deleteBuffer(buffer);
      gl.deleteShader(vertex);
      gl.deleteShader(fragment);
      gl.deleteProgram(program);
    };
  }, [size]);

  return (
    <div
      ref={hostRef}
      role="img"
      aria-label={label}
      data-state={state}
      style={{
        width: size,
        height: size,
        position: "relative",
        flexShrink: 0,
      }}
    >
      <div
        aria-hidden="true"
        style={{
          position: "absolute",
          inset: "8%",
          borderRadius: "50%",
          backgroundColor: colorTo,
          filter: `blur(${Math.max(10, Math.round(size * 0.11))}px)`,
          opacity: state === "speaking" ? 0.42 : 0.24,
          transition: "opacity 200ms ease",
        }}
      />
      {fallback ? (
        <div
          aria-hidden="true"
          style={{
            position: "absolute",
            inset: 0,
            borderRadius: "50%",
            background: `radial-gradient(circle at 30% 24%, rgba(255,255,255,.72), transparent 26%), conic-gradient(from 215deg, ${colorFrom}, ${colorTo}, ${colorFrom}, ${colorTo})`,
          }}
        />
      ) : (
        <canvas
          ref={canvasRef}
          aria-hidden="true"
          style={{ position: "relative", width: size, height: size, borderRadius: "50%" }}
        />
      )}
    </div>
  );
}
