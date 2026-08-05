// The little question box shown when a second video is dropped (or opened)
// while one video is already open and the "Second video" setting is "Prompt".
// It asks whether to replace the current video or add the new one as a layer,
// and offers to remember the answer. Built once on first use and reused.
//
// promptForSecondVideoChoice() resolves to { choice, save } where choice is
// 'replace' or 'new-layer' and save says whether to persist it to Settings, or
// to null if the user cancels (or dismisses with Escape). A click outside the
// box (on the backdrop) is ignored.

let dialogElement = null;
let replaceRadio = null;
let newLayerRadio = null;
let saveCheckbox = null;
let resolveCurrent = null;

function buildDialog() {
  dialogElement = document.createElement('dialog');
  dialogElement.className = 'settings-dialog second-video-dialog';

  const heading = document.createElement('h2');
  heading.textContent = 'Second video';
  dialogElement.appendChild(heading);

  const question = document.createElement('p');
  question.className = 'second-video-question';
  question.textContent = 'A video is already open. What should this one do?';
  dialogElement.appendChild(question);

  // Two mutually exclusive choices, presented as radios so both are visible.
  const choices = document.createElement('div');
  choices.className = 'second-video-choices';
  const makeChoice = (value, text, checked) => {
    const label = document.createElement('label');
    label.className = 'second-video-choice';
    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'second-video-choice';
    radio.value = value;
    radio.checked = checked;
    label.append(radio, ' ', text);
    choices.appendChild(label);
    return radio;
  };
  // New layer is the non-destructive default (it keeps the current video).
  replaceRadio = makeChoice('replace', 'Replace the current video', false);
  newLayerRadio = makeChoice('new-layer', 'Add as a new layer', true);
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
  // Take initial focus so Enter confirms the default choice, rather than
  // showModal() landing focus on the first (unchecked) radio.
  okButton.autofocus = true;
  okButton.addEventListener('click', () => settle({
    choice: replaceRadio.checked ? 'replace' : 'new-layer',
    save: saveCheckbox.checked,
  }));
  buttonRow.append(cancelButton, okButton);
  dialogElement.appendChild(buttonRow);

  // Escape (the dialog's native 'cancel') counts as canceling — the load does
  // not happen. A click on the backdrop is deliberately ignored so the box can
  // only be dismissed via Cancel/OK or Escape/Enter.
  dialogElement.addEventListener('cancel', (event) => { event.preventDefault(); settle(null); });

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
  newLayerRadio.checked = true;
  replaceRadio.checked = false;
  saveCheckbox.checked = false;

  return new Promise((resolve) => {
    resolveCurrent = resolve;
    dialogElement.showModal();
  });
}
