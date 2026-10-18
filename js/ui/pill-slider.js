// A pill slider: a rounded track holding two or more mutually exclusive
// options side by side, with a highlighted thumb that slides under whichever
// one is chosen. Used wherever the app asks the user to pick one of a few
// short options (the second-media question box, and several Settings rows).
// Clicking an option, or pressing the left/right arrow keys while one has
// focus, chooses it. All options are equally wide (as wide as the longest),
// so the thumb lines up with each of them.
//
// createPillSlider({ options, value, onChange, label }) returns
//   { element, getValue(), setValue(value), setLocked(locked, onLockedClick) }
// where options is a list of [value, text] pairs. setValue does not call
// onChange; only a choice the user makes does. While locked, the slider is
// dimmed and clicking it calls onLockedClick instead of changing the value.

export function createPillSlider({ options, value, onChange, label }) {
  const element = document.createElement('div');
  element.className = 'pill-slider';
  element.setAttribute('role', 'group');
  if (label) element.setAttribute('aria-label', label);
  element.style.setProperty('--pill-slider-option-count', String(options.length));

  const thumb = document.createElement('div');
  thumb.className = 'pill-slider-thumb';
  thumb.setAttribute('aria-hidden', 'true');
  element.appendChild(thumb);

  const buttons = options.map(([optionValue, text]) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'pill-slider-option';
    button.dataset.value = optionValue;
    button.textContent = text;
    button.addEventListener('click', () => choose(optionValue));
    element.appendChild(button);
    return button;
  });

  let currentValue = null;
  let locked = false;
  let lockedClickHandler = null;

  function setValue(newValue) {
    const index = Math.max(0, options.findIndex(([optionValue]) => optionValue === newValue));
    currentValue = options[index][0];
    element.dataset.value = currentValue;
    element.style.setProperty('--pill-slider-selected-index', String(index));
    buttons.forEach((button, buttonIndex) => {
      button.classList.toggle('selected', buttonIndex === index);
      button.setAttribute('aria-pressed', String(buttonIndex === index));
    });
  }

  function choose(newValue) {
    if (locked) {
      lockedClickHandler?.();
      return;
    }
    if (newValue === currentValue) return;
    setValue(newValue);
    onChange?.(currentValue);
  }

  element.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const index = options.findIndex(([optionValue]) => optionValue === currentValue);
    const step = event.key === 'ArrowLeft' ? -1 : 1;
    const nextIndex = Math.min(options.length - 1, Math.max(0, index + step));
    choose(options[nextIndex][0]);
    buttons[options.findIndex(([optionValue]) => optionValue === currentValue)].focus();
  });

  function setLocked(newLocked, onLockedClick) {
    locked = newLocked;
    lockedClickHandler = onLockedClick ?? null;
    element.classList.toggle('locked', locked);
    buttons.forEach((button) => button.setAttribute('aria-disabled', String(locked)));
  }

  setValue(value);
  return { element, getValue: () => currentValue, setValue, setLocked };
}
