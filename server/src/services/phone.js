// One phone format enforced everywhere it's entered: a place's main line, a
// person's direct line, and a visit's contact snapshot. Mirrors the client's
// PhoneInput auto-formatter (client/src/components/ui/PhoneInput.jsx) so a
// request from outside the app's own forms still gets the same rule applied.
const PHONE_REGEX = /^\(\d{3}\) \d{3}-\d{4}$/;

// Returns an error string if `value` is set but not a complete
// "(402) 555-1234", or null if it's empty (phone is always optional) or valid.
function validatePhone(value) {
  if (!value) return null;
  return PHONE_REGEX.test(value) ? null : 'phone must be in the format (402) 555-1234';
}

module.exports = { PHONE_REGEX, validatePhone };
