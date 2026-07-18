// Undo/redo history. Every mutation of the annotation document flows through
// execute() as a command object { label, apply(), revert() } whose two
// functions are exact inverses.

const MAXIMUM_HISTORY_LENGTH = 500;

export class UndoHistory extends EventTarget {
  #undoStack = [];
  #redoStack = [];

  execute(command) {
    command.apply();
    this.#undoStack.push(command);
    if (this.#undoStack.length > MAXIMUM_HISTORY_LENGTH) this.#undoStack.shift();
    this.#redoStack.length = 0;
    this.dispatchEvent(new CustomEvent('history-changed'));
  }

  undo() {
    const command = this.#undoStack.pop();
    if (!command) return;
    command.revert();
    this.#redoStack.push(command);
    this.dispatchEvent(new CustomEvent('history-changed'));
  }

  redo() {
    const command = this.#redoStack.pop();
    if (!command) return;
    command.apply();
    this.#undoStack.push(command);
    this.dispatchEvent(new CustomEvent('history-changed'));
  }

  get canUndo() { return this.#undoStack.length > 0; }
  get canRedo() { return this.#redoStack.length > 0; }
  get nextUndoLabel() { return this.#undoStack.at(-1)?.label ?? null; }
  get nextRedoLabel() { return this.#redoStack.at(-1)?.label ?? null; }

  clear() {
    this.#undoStack.length = 0;
    this.#redoStack.length = 0;
    this.dispatchEvent(new CustomEvent('history-changed'));
  }
}
