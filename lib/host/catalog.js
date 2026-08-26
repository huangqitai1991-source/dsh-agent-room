/**
 * dsh-agent-room — capability & role catalog.
 *
 * Data-driven tables (kept as plain data, no logic) mapping installed tool
 * names onto a small, high-signal capability taxonomy, plus the lightweight
 * workflow role vocabulary. `capabilities` are English keys used for matching
 * across nodes; labels are bilingual for display only.
 */
export const CAPABILITY_KEYS = [
    "web-search",
    "fs-io",
    "code-exec",
    "image",
    "orchestration",
    "room-collab",
];
/** Tool name -> capability key. Skills pass through under their own name. */
export const TOOL_CAPABILITY_MAP = {
    web_search: "web-search",
    read: "fs-io",
    write: "fs-io",
    edit: "fs-io",
    glob: "fs-io",
    grep: "fs-io",
    read_image: "image",
    pwsh: "code-exec",
    bash: "code-exec",
    subagent: "orchestration",
    subagent_fork: "orchestration",
    workflow: "orchestration",
    ralph: "orchestration",
    room_create: "room-collab",
    room_join: "room-collab",
    room_send: "room-collab",
};
/** Tools every agent has — no signal, never mapped to a capability. */
export const CAPABILITY_IGNORE = new Set([
    "job_list",
    "job_kill",
    "job_output",
    "interrupt_agent",
    "list_agents",
    "send_message",
    "ask_user_question",
    "create_goal",
    "get_goal",
    "update_goal",
    "todo_write",
    "skill",
    "watch",
]);
/** Capabilities everyone in an agent-room node shares — sort weight 0. */
export const ZERO_WEIGHT_CAPABILITIES = new Set(["room-collab"]);
export const CAPABILITY_LABELS = {
    "web-search": { zh: "网页搜索", en: "Web search" },
    "fs-io": { zh: "文件读写", en: "File I/O" },
    "code-exec": { zh: "代码执行", en: "Code execution" },
    image: { zh: "图像理解", en: "Image understanding" },
    orchestration: { zh: "子代理编排", en: "Orchestration" },
    "room-collab": { zh: "房间协作", en: "Room collaboration" },
};
export const ROLE_KEYS = ["observer", "controller", "researcher", "executor", "reviewer"];
export const ROLE_LABELS = {
    observer: { zh: "观察者", en: "Observer" },
    controller: { zh: "总控", en: "Controller" },
    researcher: { zh: "资料", en: "Researcher" },
    executor: { zh: "执行", en: "Executor" },
    reviewer: { zh: "复核", en: "Reviewer" },
};
/** Map a tool name to its capability key, or undefined when it has no signal. */
export function capabilityForTool(toolName) {
    if (CAPABILITY_IGNORE.has(toolName))
        return undefined;
    return TOOL_CAPABILITY_MAP[toolName];
}
