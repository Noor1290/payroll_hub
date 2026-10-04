/** After React has marked the fields, moves to the first one that needs attention. */
export function focusFirstInvalid(form: HTMLFormElement | null) {
  setTimeout(() => form?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus());
}
