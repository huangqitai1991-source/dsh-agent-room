/**
 * dsh-agent-room — bundled skill provider (mirrors the dsh-univer-office pattern).
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { BUNDLED_SKILL_RANK } from "@deepseek-ai/dsh-skill";
const PROVIDER_NAME = "agent-room";
const INVOCATION = { modelInvocable: true, userInvocable: true };
const DEFINITIONS = [
    {
        name: "agent-room",
        description: "Cross-instance agent collaboration rooms: create/join rooms on other DSH nodes, chat to coordinate, create/claim/assign tasks with capability matching, and respect the judging model (controller approval vs autonomous mode).",
    },
];
const CANDIDATES = DEFINITIONS.map((definition) => {
    const url = new URL(`../skills/${definition.name}/SKILL.md`, import.meta.url);
    return {
        ...definition,
        invocation: INVOCATION,
        provider: PROVIDER_NAME,
        source: "bundled",
        resourceBase: { kind: "directory", path: fileURLToPath(new URL(`../skills/${definition.name}/`, import.meta.url)) },
        rank: BUNDLED_SKILL_RANK,
        locator: url,
    };
});
const provider = {
    name: PROVIDER_NAME,
    list: () => Promise.resolve(CANDIDATES),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async get(candidate) {
        if (!(candidate.locator instanceof URL))
            throw new Error("agent-room skill locator must be a URL");
        return {
            name: candidate.name,
            description: candidate.description,
            invocation: candidate.invocation,
            provider: candidate.provider,
            source: candidate.source,
            resourceBase: candidate.resourceBase,
            rank: candidate.rank,
            content: stripFrontmatter(await readFile(candidate.locator, "utf8")),
        };
    },
};
export const name = "agent-room-skills";
export const inject = ["skills"];
export function apply(ctx) {
    ctx.skills.registerProvider(() => provider);
}
function stripFrontmatter(value) {
    if (!value.startsWith("---\n"))
        return value;
    const end = value.indexOf("\n---\n", 4);
    return end === -1 ? value : value.slice(end + 5);
}
