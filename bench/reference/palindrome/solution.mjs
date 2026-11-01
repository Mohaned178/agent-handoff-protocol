export function isPalindrome(text) {
  const letters = [...text.toLowerCase()].filter((c) => /[a-z0-9]/.test(c));
  return letters.join("") === [...letters].reverse().join("");
}
