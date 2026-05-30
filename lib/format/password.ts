export type PasswordStrength = {
  minLength: boolean;
  hasUpper: boolean;
  hasLower: boolean;
  hasDigit: boolean;
  hasSpecial: boolean;
  allValid: boolean;
};

export function checkPasswordStrength(password: string): PasswordStrength {
  const minLength = password.length >= 10;
  const hasUpper = /[A-Z]/.test(password);
  const hasLower = /[a-z]/.test(password);
  const hasDigit = /\d/.test(password);
  const hasSpecial = /[^A-Za-z0-9]/.test(password);

  return {
    minLength,
    hasUpper,
    hasLower,
    hasDigit,
    hasSpecial,
    allValid: minLength && hasUpper && hasLower && hasDigit && hasSpecial,
  };
}
