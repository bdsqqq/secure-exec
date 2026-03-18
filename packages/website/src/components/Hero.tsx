"use client";

import { useState, useEffect, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { ArrowRight, Terminal, Check, ChevronDown } from "lucide-react";
import { CopyButton } from "./ui/CopyButton";
import { LightningBackground } from "./ui/LightningBackground";
import { HeroLogo } from "./HeroLogo";

const codeRaw = `import { generateText, stepCountIs, tool } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { NodeRuntime, createNodeDriver, createNodeRuntimeDriverFactory } from "secure-exec";
import { z } from "zod";

const runtime = new NodeRuntime({
  systemDriver: createNodeDriver({
    permissions: {
      fs: () => ({ allow: true }),
      network: () => ({ allow: true }),
    },
  }),
  runtimeDriverFactory: createNodeRuntimeDriverFactory(),
  memoryLimit: 64,
  cpuTimeLimitMs: 5000,
});

const { text } = await generateText({
  model: anthropic("claude-sonnet-4-6"),
  prompt: "Calculate the first 20 fibonacci numbers",
  stopWhen: stepCountIs(5),
  tools: {
    execute: tool({
      description: "Run JavaScript in a secure sandbox. Assign the result to module.exports to return data.",
      inputSchema: z.object({ code: z.string() }),
      execute: async ({ code }) => runtime.run(code),
    }),
  },
});

console.log(text);`;

function CodeBlock() {
  return (
    <div className="overflow-hidden rounded-xl bg-[#0c0c0e] shadow-2xl chrome-gradient-border" style={{ "--chrome-angle": "240deg" } as React.CSSProperties}>
      <div className="flex items-center justify-between bg-white/5 px-4 py-2.5 chrome-divider">
        <span className="text-xs font-medium text-zinc-500">agent.ts</span>
        <CopyButton text={codeRaw} />
      </div>
      <pre className="overflow-x-auto p-4 font-mono text-[12px] leading-relaxed">
        <code>
          <span className="text-purple-400">import</span>
          <span className="text-zinc-300">{" { "}</span>
          <span className="text-white">generateText</span>
          <span className="text-zinc-300">, </span>
          <span className="text-white">stepCountIs</span>
          <span className="text-zinc-300">, </span>
          <span className="text-white">tool</span>
          <span className="text-zinc-300">{" } "}</span>
          <span className="text-purple-400">from</span>
          <span className="text-zinc-300"> </span>
          <span className="text-green-400">"ai"</span>
          <span className="text-zinc-300">;</span>
          {"\n"}
          <span className="text-purple-400">import</span>
          <span className="text-zinc-300">{" { "}</span>
          <span className="text-white">anthropic</span>
          <span className="text-zinc-300">{" } "}</span>
          <span className="text-purple-400">from</span>
          <span className="text-zinc-300"> </span>
          <span className="text-green-400">"@ai-sdk/anthropic"</span>
          <span className="text-zinc-300">;</span>
          {"\n"}
          <span className="text-purple-400">import</span>
          <span className="text-zinc-300">{" { "}</span>
          <span className="text-white">NodeRuntime</span>
          <span className="text-zinc-300">, </span>
          <span className="text-white">createNodeDriver</span>
          <span className="text-zinc-300">, </span>
          <span className="text-white">createNodeRuntimeDriverFactory</span>
          <span className="text-zinc-300">{" } "}</span>
          <span className="text-purple-400">from</span>
          <span className="text-zinc-300"> </span>
          <span className="text-green-400">"secure-exec"</span>
          <span className="text-zinc-300">;</span>
          {"\n"}
          <span className="text-purple-400">import</span>
          <span className="text-zinc-300">{" { "}</span>
          <span className="text-white">z</span>
          <span className="text-zinc-300">{" } "}</span>
          <span className="text-purple-400">from</span>
          <span className="text-zinc-300"> </span>
          <span className="text-green-400">"zod"</span>
          <span className="text-zinc-300">;</span>
          {"\n\n"}

          <span className="text-zinc-500">// Create a sandboxed runtime</span>
          {"\n"}
          <span className="text-purple-400">const</span>
          <span className="text-zinc-300"> runtime = </span>
          <span className="text-purple-400">new</span>
          <span className="text-zinc-300"> </span>
          <span className="text-blue-400">NodeRuntime</span>
          <span className="text-zinc-300">{"({"}</span>
          {"\n"}
          <span className="text-zinc-300">{"  systemDriver: "}</span>
          <span className="text-blue-400">createNodeDriver</span>
          <span className="text-zinc-300">{"({"}</span>
          {"\n"}
          <span className="text-zinc-300">{"    permissions: {"}</span>
          {"\n"}
          <span className="text-zinc-300">{"      fs: () => ({ allow: "}</span>
          <span className="text-orange-400">true</span>
          <span className="text-zinc-300">{" }),"}</span>
          {"\n"}
          <span className="text-zinc-300">{"      network: () => ({ allow: "}</span>
          <span className="text-orange-400">true</span>
          <span className="text-zinc-300">{" }),"}</span>
          {"\n"}
          <span className="text-zinc-300">{"    },"}</span>
          {"\n"}
          <span className="text-zinc-300">{"  }),"}</span>
          {"\n"}
          <span className="text-zinc-300">{"  runtimeDriverFactory: "}</span>
          <span className="text-blue-400">createNodeRuntimeDriverFactory</span>
          <span className="text-zinc-300">{"(),"}</span>
          {"\n"}
          <span className="text-zinc-300">{"  memoryLimit: "}</span>
          <span className="text-orange-400">64</span>
          <span className="text-zinc-300">,</span>
          {"\n"}
          <span className="text-zinc-300">{"  cpuTimeLimitMs: "}</span>
          <span className="text-orange-400">5000</span>
          <span className="text-zinc-300">,</span>
          {"\n"}
          <span className="text-zinc-300">{"});"}</span>
          {"\n\n"}

          <span className="text-zinc-500">// Expose as an AI SDK tool</span>
          {"\n"}
          <span className="text-purple-400">const</span>
          <span className="text-zinc-300">{" { text } = "}</span>
          <span className="text-purple-400">await</span>
          <span className="text-zinc-300"> </span>
          <span className="text-blue-400">generateText</span>
          <span className="text-zinc-300">{"({"}</span>
          {"\n"}
          <span className="text-zinc-300">{"  model: "}</span>
          <span className="text-blue-400">anthropic</span>
          <span className="text-zinc-300">{"("}</span>
          <span className="text-green-400">"claude-sonnet-4-6"</span>
          <span className="text-zinc-300">{"),"}</span>
          {"\n"}
          <span className="text-zinc-300">{"  prompt: "}</span>
          <span className="text-green-400">"Calculate the first 20 fibonacci numbers"</span>
          <span className="text-zinc-300">,</span>
          {"\n"}
          <span className="text-zinc-300">{"  stopWhen: "}</span>
          <span className="text-blue-400">stepCountIs</span>
          <span className="text-zinc-300">{"("}</span>
          <span className="text-orange-400">5</span>
          <span className="text-zinc-300">{"),"}</span>
          {"\n"}
          <span className="text-zinc-300">{"  tools: {"}</span>
          {"\n"}
          <span className="text-zinc-300">{"    execute: "}</span>
          <span className="text-blue-400">tool</span>
          <span className="text-zinc-300">{"({"}</span>
          {"\n"}
          <span className="text-zinc-300">{"      description: "}</span>
          <span className="text-green-400">"Run JavaScript in a secure sandbox. Assign the result to module.exports to return data."</span>
          <span className="text-zinc-300">,</span>
          {"\n"}
          <span className="text-zinc-300">{"      inputSchema: z."}</span>
          <span className="text-blue-400">object</span>
          <span className="text-zinc-300">{"({ code: z."}</span>
          <span className="text-blue-400">string</span>
          <span className="text-zinc-300">{"() }),"}</span>
          {"\n"}
          <span className="text-zinc-300">{"      execute: "}</span>
          <span className="text-purple-400">async</span>
          <span className="text-zinc-300">{" ({ code }) => runtime."}</span>
          <span className="text-blue-400">run</span>
          <span className="text-zinc-300">{"(code),"}</span>
          {"\n"}
          <span className="text-zinc-300">{"    }),"}</span>
          {"\n"}
          <span className="text-zinc-300">{"  },"}</span>
          {"\n"}
          <span className="text-zinc-300">{"});"}</span>
          {"\n\n"}
          <span className="text-white">console</span>
          <span className="text-zinc-300">.</span>
          <span className="text-blue-400">log</span>
          <span className="text-zinc-300">(text);</span>
        </code>
      </pre>
    </div>
  );
}

const CopyInstallButton = () => {
  const [copied, setCopied] = useState(false);
  const installCommand = "npm install secure-exec";

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(installCommand);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error("Failed to copy:", err);
    }
  };

  return (
    <button
      onClick={handleCopy}
      className="w-full sm:w-auto inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md btn-chrome-outline px-4 py-2.5 text-sm font-mono"
      style={{ "--chrome-angle": "300deg" } as React.CSSProperties}
    >
      {copied ? <Check className="h-4 w-4 text-green-400" /> : <Terminal className="h-4 w-4 flex-shrink-0" />}
      <span>{installCommand}</span>
    </button>
  );
};

function AmbientSparkles() {
  const [sparkles, setSparkles] = useState<{ id: number; x: number; y: number; size: number; duration: number }[]>([]);
  const idRef = useRef(0);

  useEffect(() => {
    const tick = () => {
      const id = idRef.current++;
      const sparkle = {
        id,
        x: Math.random() * 100,
        y: Math.random() * 100,
        size: 14 + Math.random() * 28,
        duration: 1 + Math.random() * 2,
      };
      setSparkles((prev) => [...prev, sparkle]);
      setTimeout(() => {
        setSparkles((prev) => prev.filter((s) => s.id !== id));
      }, sparkle.duration * 1000 + 300);
      timer = setTimeout(tick, 150 + Math.random() * 400);
    };
    let timer = setTimeout(tick, 2000);
    return () => clearTimeout(timer);
  }, []);

  return (
    <div className="absolute inset-0 pointer-events-none overflow-hidden">
      <AnimatePresence>
        {sparkles.map((s) => (
          <div key={s.id} className="absolute" style={{ left: `${s.x}%`, top: `${s.y}%` }}>
            <motion.div
              initial={{ opacity: 0, scale: 0 }}
              animate={{ opacity: 0.6, scale: 1 }}
              exit={{ opacity: 0, scale: 0 }}
              transition={{ duration: s.duration * 0.4, ease: "easeOut" }}
              style={{ marginLeft: -s.size / 2, marginTop: -s.size / 2 }}
            >
              <svg width={s.size} height={s.size} viewBox="0 0 24 24" fill="none" style={{ filter: "blur(0.5px)" }}>
                <path
                  d="M12 0 L12.4 11 L24 12 L12.4 13 L12 24 L11.6 13 L0 12 L11.6 11 Z"
                  fill="white"
                  opacity="0.7"
                />
              </svg>
            </motion.div>
          </div>
        ))}
      </AnimatePresence>
    </div>
  );
}

export function Hero() {
  const [scrollY, setScrollY] = useState(0);
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const updateViewportMode = () => {
      setIsMobile(window.innerWidth < 1024);
    };

    const handleScroll = () => {
      setScrollY(window.scrollY);
    };

    updateViewportMode();
    handleScroll();
    window.addEventListener("resize", updateViewportMode);
    window.addEventListener("scroll", handleScroll);
    return () => {
      window.removeEventListener("resize", updateViewportMode);
      window.removeEventListener("scroll", handleScroll);
    };
  }, []);

  return (
    <>
      <section className="relative flex min-h-screen flex-col overflow-hidden">
        <div className="absolute inset-0 bg-[#09090b] pointer-events-none" />
        <div
          className="absolute inset-0"
          style={isMobile ? undefined : { transform: `translateY(${scrollY * 0.15}px)` }}
        >
          <LightningBackground />
        </div>
        <AmbientSparkles />

        <div
          className="flex flex-1 flex-col justify-center px-6"
          style={undefined}
        >
          <div className="mx-auto w-full max-w-4xl text-center">
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 1.2, ease: "easeOut" }}
              className="flex justify-center"
              style={isMobile ? undefined : { transform: `translateY(${scrollY * -0.25}px)` }}
            >
              <HeroLogo />
            </motion.div>

            <div className="mt-16 md:mt-20" style={isMobile ? undefined : { transform: `translateY(${scrollY * -0.4}px)` }}>
              <motion.h1
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.7, delay: 0.3, ease: [0.16, 1, 0.3, 1] }}
                className="mb-6 text-2xl font-semibold leading-[1.15] tracking-tight text-white"
                style={{ fontFamily: "'Inter', sans-serif" }}
              >
                Secure Node.js Execution Without a Sandbox
              </motion.h1>

              <motion.p
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.6, delay: 0.7 }}
                className="mx-auto mb-10 max-w-2xl text-lg text-zinc-500 leading-relaxed"
              >
                <span className="whitespace-nowrap">A lightweight library for secure Node.js execution.</span>
                <br />
                <span className="whitespace-nowrap">No containers, no VMs — just npm-compatible sandboxing out of the box.</span>
				<br />
                <span className="whitespace-nowrap"> Powered by the same tech as Cloudflare Workers.</span>
              </motion.p>

              <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.5, delay: 0.9 }}
                className="flex flex-col items-center gap-3 sm:flex-row sm:justify-center"
              >
                <a
                  href="/docs"
                  className="selection-dark inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md btn-chrome px-5 py-2.5 text-sm"
                  style={{ "--chrome-angle": "170deg" } as React.CSSProperties}
                >
                  Get Started
                  <ArrowRight className="h-4 w-4" />
                </a>
                <CopyInstallButton />
              </motion.div>
            </div>
          </div>

          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 1, delay: 1.5 }}
            className="mt-16 flex justify-center"
          >
            <motion.div
              animate={{ y: [0, 6, 0] }}
              transition={{ duration: 2, repeat: Infinity, ease: "easeInOut" }}
            >
              <ChevronDown className="h-5 w-5 text-zinc-600" />
            </motion.div>
          </motion.div>
        </div>
      </section>

      <section className="relative px-6 pb-48">
        <div className="mx-auto w-full max-w-3xl">
          <motion.div
            initial={{ opacity: 0, y: 30 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: "-100px" }}
            transition={{ duration: 0.6 }}
            className="text-center mb-8"
          >
            <h2 className="text-2xl font-semibold text-white mb-3">Give your AI agent secure code execution</h2>
            <p className="text-zinc-500 max-w-lg mx-auto">
              Expose secure-exec as a tool with the Vercel AI SDK. Your agent can execute arbitrary code without risking your infrastructure.
            </p>
          </motion.div>
          <motion.div
            initial={{ opacity: 0, y: 30 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: "-100px" }}
            transition={{ duration: 0.6, delay: 0.1 }}
          >
            <CodeBlock />
          </motion.div>
        </div>
      </section>
    </>
  );
}
