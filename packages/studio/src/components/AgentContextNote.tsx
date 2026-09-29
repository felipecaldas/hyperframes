/**
 * What Tabario AI was told alongside a message, shown under that message
 * (TAB-1194).
 *
 * A message sent with an element selected on the timeline reaches the model
 * with a description of that element. Until TAB-1194 the description was joined
 * into the user's own turn and the drawer showed the typed words alone, so the
 * model read a sentence the user had apparently said and the user never saw.
 * The description is built from the element's `data-hf-label`, which is text
 * out of a project file.
 *
 * This is the server's account of what it sent, not the drawer's guess from
 * the selection it holds. It is folded away because most of the time it says
 * what the user already knows, and it is there because the one time it does
 * not is the time that matters.
 */
export function AgentContextNote({ context }: { context: string | null | undefined }) {
  if (!context) return null;
  return (
    <details data-agent-context className="mt-1.5 border-t border-neutral-700/60 pt-1.5">
      <summary className="cursor-pointer text-[10px] text-neutral-500">
        Also sent to Tabario AI
      </summary>
      <div className="mt-1 whitespace-pre-wrap break-words text-[10px] text-neutral-400">
        {context}
      </div>
    </details>
  );
}
