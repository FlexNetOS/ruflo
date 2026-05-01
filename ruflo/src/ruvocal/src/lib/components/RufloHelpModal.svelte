<script lang="ts">
	import Modal from "./Modal.svelte";
	import CarbonClose from "~icons/carbon/close";

	interface Props {
		onclose?: () => void;
	}

	let { onclose }: Props = $props();

	type Tool = { name: string; desc: string };
	type Group = { id: string; title: string; emoji: string; intro: string; tools: Tool[] };

	const groups: Group[] = [
		{
			id: "memory",
			title: "Memory & Knowledge",
			emoji: "🧠",
			intro: "Persistent cross-session memory backed by AgentDB. Store and recall by key or semantic search.",
			tools: [
				{ name: "ruflo__memory_store", desc: "Save a key/value into a namespace." },
				{ name: "ruflo__memory_search", desc: "Semantic vector search over stored memories." },
				{ name: "ruflo__memory_retrieve", desc: "Fetch a specific entry by key + namespace." },
				{ name: "ruflo__memory_list", desc: "List entries in a namespace." },
				{ name: "ruflo__embeddings_compare", desc: "Compare two pieces of text by semantic similarity." },
				{ name: "ruflo__agentdb_*", desc: "Lower-level AgentDB controllers (route, consolidate, hierarchical)." },
			],
		},
		{
			id: "agents",
			title: "Agents & Orchestration",
			emoji: "🤖",
			intro: "Spawn agents, coordinate swarms, run hive-mind consensus, manage tasks.",
			tools: [
				{ name: "ruflo__agent_spawn", desc: "Create a new specialized agent (coder, tester, reviewer, …)." },
				{ name: "ruflo__swarm_init", desc: "Initialize a swarm with topology + strategy." },
				{ name: "ruflo__hive-mind_*", desc: "Queen-led Byzantine fault-tolerant collective." },
				{ name: "ruflo__task_create", desc: "Create + assign a task to an agent." },
				{ name: "ruflo__agent_list", desc: "List active agents and their state." },
			],
		},
		{
			id: "intelligence",
			title: "Intelligence & Learning",
			emoji: "✨",
			intro: "Pattern learning, routing, code analysis, and trajectory tracking via RuVector.",
			tools: [
				{ name: "ruvector__hooks_route", desc: "Pick the optimal agent type for a task." },
				{ name: "ruvector__hooks_remember / recall", desc: "Cross-session key/value memory." },
				{ name: "ruvector__hooks_trajectory_*", desc: "Record multi-step task execution for learning." },
				{ name: "ruvector__hooks_security_scan", desc: "Scan code for vulnerabilities." },
				{ name: "ruvector__hooks_rag_context", desc: "Get retrieval-augmented context for a query." },
				{ name: "ruvector__hooks_swarm_recommend", desc: "Recommend swarm topology for a task." },
			],
		},
		{
			id: "devtools",
			title: "Dev Tools & Analysis",
			emoji: "🛠️",
			intro: "System health, performance profiling, GitHub integration, and shell access.",
			tools: [
				{ name: "ruflo__system_status", desc: "Overall system health overview." },
				{ name: "ruflo__performance_metrics", desc: "Detailed performance metrics." },
				{ name: "ruflo__performance_bottleneck", desc: "Identify performance bottlenecks." },
				{ name: "ruflo__analyze_diff", desc: "Risk-score and classify a code diff." },
				{ name: "ruflo__github_repo_analyze", desc: "Repo metrics and structure analysis." },
				{ name: "ruflo__terminal_execute", desc: "Run a shell command." },
				{ name: "ruflo__progress_*", desc: "Implementation progress tracking." },
			],
		},
		{
			id: "core",
			title: "Core Tools",
			emoji: "⚡",
			intro: "Built-in tools always available regardless of MCP configuration.",
			tools: [
				{ name: "search", desc: "Search the local knowledge base." },
				{ name: "web_research", desc: "Web search, deep research, comparisons, fact-checking." },
				{ name: "guidance", desc: "Get help on any tool group or specific tool. Topics: overview, groups, agents, memory, intelligence, devtools." },
			],
		},
		{
			id: "wasm",
			title: "WASM Gallery (Browser-side)",
			emoji: "🧩",
			intro: "In-browser MCP server (rvagent-wasm) with persistent IndexedDB storage. Works offline, no server roundtrip.",
			tools: [
				{ name: "WASM gallery", desc: "18 templates exposed via the local WASM MCP server (visible as MCP (1) in the chat input)." },
				{ name: "Custom templates", desc: "Add your own via the MCP Servers panel → Add Server." },
			],
		},
	];

	const tips = [
		'Click the **MCP** pill above the message box to manage servers and toggle individual tools.',
		'**AUTO** = autopilot mode. ON: tool calls chain automatically. OFF: stops between calls so you can inspect each result.',
		'For long-horizon work, use `ruvector__hooks_trajectory_begin` so the system learns from the run.',
		'Memory persists across sessions — say "remember that X" or "what did we save about Y" anytime.',
		'Tool names are prefixed with their backend (`ruflo__`, `ruvector__`). Always use the full name when invoking explicitly.',
	];

	let openGroup = $state<string | null>("memory");
</script>

<Modal width="max-w-2xl" closeButton={false} {onclose}>
	<div class="flex max-h-[85vh] w-full flex-col overflow-hidden rounded-2xl bg-white text-gray-900 dark:bg-gray-900 dark:text-gray-100">
		<header class="flex items-center justify-between border-b border-gray-200 px-6 py-4 dark:border-gray-700">
			<div class="flex items-center gap-3">
				<span class="text-2xl">📘</span>
				<div>
					<h2 class="text-lg font-semibold">RuFlo Capabilities</h2>
					<p class="text-xs text-gray-500 dark:text-gray-400">~210 MCP tools across 5 server groups + WASM gallery.</p>
				</div>
			</div>
			<button
				type="button"
				onclick={() => onclose?.()}
				class="flex size-8 items-center justify-center rounded-full text-gray-500 hover:bg-gray-100 hover:text-gray-900 dark:hover:bg-gray-700 dark:hover:text-white"
				aria-label="Close help"
			>
				<CarbonClose />
			</button>
		</header>

		<div class="flex-1 overflow-y-auto px-6 py-4">
			<section class="mb-6">
				<h3 class="mb-2 text-sm font-semibold uppercase tracking-wide text-gray-500">Quick start</h3>
				<ol class="list-decimal space-y-1.5 pl-5 text-sm">
					<li>Pick a model (default: <code class="rounded bg-gray-100 px-1 dark:bg-gray-800">Gemini 2.5 Flash</code>).</li>
					<li>Click an example below the chat box, or type your own prompt.</li>
					<li>RuFlo decides which tools to call. Watch the streaming tool-call cards below your message.</li>
					<li>Use <strong>AUTO</strong> on the chat box to auto-continue tool chains.</li>
				</ol>
			</section>

			<section class="mb-6">
				<h3 class="mb-2 text-sm font-semibold uppercase tracking-wide text-gray-500">Tool groups</h3>
				<div class="space-y-2">
					{#each groups as group}
						<details
							class="rounded-lg border border-gray-200 bg-gray-50 dark:border-gray-700 dark:bg-gray-800"
							open={openGroup === group.id}
							ontoggle={(e) => {
								if ((e.currentTarget as HTMLDetailsElement).open) openGroup = group.id;
								else if (openGroup === group.id) openGroup = null;
							}}
						>
							<summary class="flex cursor-pointer items-center gap-2 px-3 py-2 text-sm font-medium">
								<span>{group.emoji}</span>
								<span>{group.title}</span>
								<span class="ml-auto rounded bg-blue-600/10 px-1.5 py-0.5 text-xs text-blue-600 dark:bg-blue-500/20 dark:text-blue-300">
									{group.tools.length} tools
								</span>
							</summary>
							<div class="border-t border-gray-200 px-3 py-2 dark:border-gray-700">
								<p class="mb-2 text-xs text-gray-600 dark:text-gray-400">{group.intro}</p>
								<ul class="space-y-1 text-xs">
									{#each group.tools as tool}
										<li class="flex gap-2">
											<code class="shrink-0 rounded bg-white px-1 py-0.5 text-[11px] font-mono dark:bg-gray-900">{tool.name}</code>
											<span class="text-gray-700 dark:text-gray-300">{tool.desc}</span>
										</li>
									{/each}
								</ul>
							</div>
						</details>
					{/each}
				</div>
			</section>

			<section class="mb-6">
				<h3 class="mb-2 text-sm font-semibold uppercase tracking-wide text-gray-500">Tips</h3>
				<ul class="list-disc space-y-1.5 pl-5 text-sm">
					{#each tips as tip}
						<li>{@html tip.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/`([^`]+)`/g, '<code class="rounded bg-gray-100 px-1 dark:bg-gray-800">$1</code>')}</li>
					{/each}
				</ul>
			</section>

			<section>
				<h3 class="mb-2 text-sm font-semibold uppercase tracking-wide text-gray-500">Resources</h3>
				<ul class="space-y-1 text-sm">
					<li>
						<a href="https://github.com/ruvnet/ruflo" target="_blank" rel="noopener" class="text-blue-600 hover:underline dark:text-blue-400">
							github.com/ruvnet/ruflo →
						</a>
					</li>
					<li>
						<a href="https://github.com/ruvnet/ruflo/blob/main/ruflo/docs/adr/ADR-033-RUVOCAL-WASM-MCP-INTEGRATION.md" target="_blank" rel="noopener" class="text-blue-600 hover:underline dark:text-blue-400">
							ADR-033 — WASM-MCP integration →
						</a>
					</li>
					<li>
						<a href="https://github.com/ruvnet/ruvector" target="_blank" rel="noopener" class="text-blue-600 hover:underline dark:text-blue-400">
							ruvnet/ruvector — intelligence layer →
						</a>
					</li>
				</ul>
			</section>
		</div>

		<footer class="flex items-center justify-end gap-2 border-t border-gray-200 px-6 py-3 dark:border-gray-700">
			<button
				type="button"
				onclick={() => onclose?.()}
				class="rounded-lg bg-gray-900 px-4 py-1.5 text-sm font-medium text-white hover:bg-black dark:bg-gray-100 dark:text-gray-900 dark:hover:bg-white"
			>
				Got it
			</button>
		</footer>
	</div>
</Modal>
