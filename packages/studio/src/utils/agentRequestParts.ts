/**
 * TAB-1221. A Studio request, in the two parts the server keeps apart: what
 * the user said, and what the panel gathered.
 *
 * The four panels that hand work to Tabario AI were written to fill a
 * clipboard. Each builds one block of text: a heading, the user's words, the
 * element or the range or the findings, and some closing rules. Sent whole, that
 * block became the user's turn, so an element's text and a checker's message,
 * both of which quote the project, reached the model as the user speaking.
 *
 * The clipboard text is left as it is, and so are the upstream functions that
 * build it. What goes to the agent is cut out of what they return.
 */

export interface AgentRequestParts {
  /** What the user typed, or the sentence that stands for the button they pressed. */
  prompt: string;
  /** What the panel gathered. It reaches the model framed as data. */
  material: string;
}

/**
 * `generated` with `head` taken off the front and everything from the last
 * `tail` taken off the end.
 *
 * When the text is not shaped that way, all of it is returned. That is the safe
 * direction to be wrong in: an upstream change to a prompt's wording sends the
 * model more material than it needed, and never puts material in the user's
 * turn. The tail is looked for from the end because what comes before it can
 * hold anything, a copy of the tail included.
 */
function cut(generated: string, head: string, tail: string): string {
  if (!generated.startsWith(head)) return generated;
  const rest = generated.slice(head.length);
  const end = rest.lastIndexOf(tail);
  return end === -1 ? generated : rest.slice(0, end);
}

const ELEMENT_CHOICE = "Edit this selected HyperFrames element.";

/** A request about one element, from `buildElementAgentPrompt`'s text. */
export function elementRequestParts(generated: string, typed: string): AgentRequestParts {
  const said = typed.trim() || ELEMENT_CHOICE;
  const head = `## HyperFrames element edit request v1\nSchema version: 1\n\n${said}\n\n`;
  return { prompt: said, material: cut(generated, head, "\n\nGuardrails:\n") };
}

const TIMELINE_CHOICE = "Edit the elements in this range of the timeline.";

/** A request about a range of the timeline, from `buildTimelineAgentPrompt`'s text. */
export function timelineRequestParts(generated: string, typed: string): AgentRequestParts {
  const said = typed.trim();
  const head = "Edit the following HyperFrames composition:\n\n";
  const tail = `\n\nUser request:\n${said || "(no prompt provided)"}\n\nInstructions:\n`;
  return { prompt: said || TIMELINE_CHOICE, material: cut(generated, head, tail) };
}

const CATALOG_CHOICE = "Add the catalog item I picked to this composition.";

/**
 * A request to add a catalog item, from the draft the user was shown and what
 * they sent.
 *
 * The draft is editable, so what comes back is part ours and part theirs, and
 * nothing marks which. A line that is in what was sent and not in the draft is
 * one the user wrote. A line they changed counts as theirs whole: they had it
 * in front of them and rewrote it. Every other line is the draft's, which names
 * the item from the registry and the elements from the project.
 */
export function catalogRequestParts(draft: string, sent: string): AgentRequestParts {
  const drafted = new Set(draft.split("\n").map((line) => line.trim()));
  const lines = sent.split("\n");
  const typed = lines.filter((line) => line.trim() && !drafted.has(line.trim()));
  const material = lines.filter((line) => drafted.has(line.trim())).join("\n");
  return { prompt: [CATALOG_CHOICE, ...typed].join("\n"), material: material.trim() };
}

/** A request to fix what a checker reported. The user typed nothing: they pressed a button. */
export function findingsRequestParts(intro: string, findings: string): AgentRequestParts {
  return { prompt: `${intro}.`, material: findings };
}
