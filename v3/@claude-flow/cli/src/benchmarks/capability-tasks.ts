// Auto-generated from src/benchmarks/capability-tasks.json — keep in sync.
// This module exists so the fixture is bundled into dist/ by tsc (JSON files
// are not copied by tsc, and the published CLI ships only dist/).

export const BUILTIN_CAPABILITY_TASKS = {
  "version": "1.0",
  "description": "Text-only agent capability benchmark — verifiable multi-step reasoning tasks scoreable without tool use. Format inspired by GAIA / SWE-bench but executable via plain Anthropic API. For full GAIA (web browsing, file attachments) see the gated --gaia-real path (not yet implemented; tracked separately).",
  "answerFormat": "Each question requires the model to reply with the answer wrapped in <answer>...</answer> tags. The harness extracts the tag contents and checks against `expected` per `matchMode`.",
  "tasks": [
    {
      "id": "math-prime",
      "category": "reasoning",
      "prompt": "What is the smallest 3-digit prime number that does not contain the digit 7?",
      "expected": "101",
      "matchMode": "exact"
    },
    {
      "id": "math-token-cost",
      "category": "multi-step-arithmetic",
      "prompt": "A workflow runs 100 tasks. 60 tasks go through a Tier-2 path costing 200 tokens each. 40 tasks go through Tier-3 costing 800 tokens each. A new simulative-planning layer reduces Tier-3 token cost by 30%. What is the new total token cost across all 100 tasks?",
      "expected": "34400",
      "matchMode": "exact"
    },
    {
      "id": "logic-syllogism",
      "category": "reasoning",
      "prompt": "All routers in tier 1 cost less than $0.001 per call. The Booster router is in tier 1. The Sonnet router costs $0.003 per call. Is the Sonnet router in tier 1? Answer with just \"yes\" or \"no\".",
      "expected": "no",
      "matchMode": "exact"
    },
    {
      "id": "code-counting",
      "category": "code-reasoning",
      "prompt": "Consider this TypeScript snippet:\n```\nexport function a() {}\nfunction b() {}\nexport const c = () => {};\nexport class D {}\nconst e = 1;\nexport { e };\n```\nHow many named exports does this module have? Answer with just an integer.",
      "expected": "4",
      "matchMode": "exact"
    },
    {
      "id": "string-manipulation",
      "category": "reasoning",
      "prompt": "If you reverse the string 'router' and concatenate it with the first 3 characters of 'planning' (in original order), what string do you get?",
      "expected": "retuorpla",
      "matchMode": "exact"
    },
    {
      "id": "regex-match",
      "category": "code-reasoning",
      "prompt": "Given the regex /^([a-z]+)-(\\d+)$/ and the input string 'pattern-1779526376', what is the value of capture group 2?",
      "expected": "1779526376",
      "matchMode": "exact"
    },
    {
      "id": "ordering",
      "category": "reasoning",
      "prompt": "Five agents finished a task with these wall-clock times in seconds: alpha=4.2, bravo=2.1, charlie=3.0, delta=5.5, echo=1.8. List them in order from fastest to slowest, comma-separated, no spaces. Example format: foo,bar,baz",
      "expected": "echo,bravo,charlie,alpha,delta",
      "matchMode": "exact"
    },
    {
      "id": "system-design",
      "category": "multi-step-reasoning",
      "prompt": "An HNSW search latency is 1.5ms and a brute-force linear scan over 1000 384-dimensional vectors takes approximately 0.5ms. What is the approximate speedup factor of HNSW over linear scan in this setup, rounded to one decimal place? Express as a single number (e.g., 12.5).",
      "expected": "0.3",
      "matchMode": "exact"
    }
  ]
} as const;
