// The little question box shown when a second video is dropped (or opened)
// while one video is already open and the "Second video" setting is "Prompt".
// It asks whether to add the new video as a layer or replace the current one,
// and offers to remember the answer. Built once on first use and reused.
//
// promptForSecondVideoChoice() resolves to { choice, save } where choice is
// 'new-layer' or 'replace' and save says whether to persist it to Settings, or
// to null if the user cancels (or dismisses with Escape). A click outside the
// box (on the backdrop) is ignored — a native <dialog> does not light-dismiss.
//
// Enter always confirms (OK) and Escape always cancels while the box is open,
// no matter where focus sits — the OK button can lose focus (e.g. the user
// clicks the backdrop), so we key off explicit handlers rather than the native
// form-submission focus dance.

let dialogElement = null;
let addLayerButton = null;
let replaceButton = null;
let saveCheckbox = null;
let resolveCurrent = null;
// The currently highlighted choice: 'new-layer' (default) or 'replace'.
let currentChoice = 'new-layer';

function selectChoice(choice) {
  currentChoice = choice;
  addLayerButton.classList.toggle('selected', choice === 'new-layer');
  addLayerButton.setAttribute('aria-pressed', String(choice === 'new-layer'));
  replaceButton.classList.toggle('selected', choice === 'replace');
  replaceButton.setAttribute('aria-pressed', String(choice === 'replace'));
}

function confirmChoice() {
  settle({ choice: currentChoice, save: saveCheckbox.checked });
}

function buildDialog() {
  dialogElement = document.createElement('dialog');
  dialogElement.className = 'settings-dialog second-video-dialog';

  const question = document.createElement('p');
  question.className = 'second-video-question';
  question.textContent = 'A video is already open. What should this one do?';
  dialogElement.appendChild(question);

  // The two mutually exclusive choices, presented as a side-by-side pair of
  // toggle buttons that only set the choice. Add layer sits on the left because
  // it is the default.
  const choices = document.createElement('div');
  choices.className = 'second-video-choices';
  const makeChoice = (value, text) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'second-video-choice';
    button.textContent = text;
    button.addEventListener('click', () => selectChoice(value));
    choices.appendChild(button);
    return button;
  };
  addLayerButton = makeChoice('new-layer', 'Add layer');
  replaceButton = makeChoice('replace', 'Replace');
  dialogElement.appendChild(choices);

  const saveLabel = document.createElement('label');
  saveLabel.className = 'second-video-save';
  saveCheckbox = document.createElement('input');
  saveCheckbox.type = 'checkbox';
  saveLabel.append(saveCheckbox, ' Save my choice to Settings');
  dialogElement.appendChild(saveLabel);

  const buttonRow = document.createElement('div');
  buttonRow.className = 'second-video-buttons';
  const cancelButton = document.createElement('button');
  cancelButton.type = 'button';
  cancelButton.textContent = 'Cancel';
  cancelButton.addEventListener('click', () => settle(null));
  const okButton = document.createElement('button');
  okButton.type = 'button';
  okButton.className = 'second-video-ok';
  okButton.textContent = 'OK';
  // Take initial focus so the OK button reads as the primary action.
  okButton.autofocus = true;
  okButton.addEventListener('click', () => confirmChoice());
  buttonRow.append(cancelButton, okButton);
  dialogElement.appendChild(buttonRow);

  // Escape (the dialog's native 'cancel') cancels. A backdrop click is
  // deliberately left unhandled so it does nothing.
  dialogElement.addEventListener('cancel', (event) => { event.preventDefault(); settle(null); });
  // Enter confirms from anywhere in the box, even when nothing (or a non-OK
  // control) holds focus — the whole point is that clicking the backdrop must
  // not disarm Enter.
  dialogElement.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      confirmChoice();
    }
  });

  document.body.appendChild(dialogElement);
}

function settle(result) {
  const resolve = resolveCurrent;
  resolveCurrent = null;
  if (dialogElement.open) dialogElement.close();
  if (resolve) resolve(result);
}

export function promptForSecondVideoChoice() {
  if (!dialogElement) buildDialog();
  // Guard against a second drop while the box is up: resolve the first as a
  // cancel so its promise never dangles.
  if (resolveCurrent) settle(null);

  // Reset to the standard defaults each time it opens.
  selectChoice('new-layer');
  saveCheckbox.checked = false;

  return new Promise((resolve) => {
    resolveCurrent = resolve;
    dialogElement.showModal();
  });
}
