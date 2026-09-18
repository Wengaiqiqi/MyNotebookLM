export type QuizQuestion = { question: string; answer: string };

// Accept both the current Q&A template and older numbered/bold Q&A output.
export function parseQuiz(content: string): QuizQuestion[] {
  const questions: QuizQuestion[] = [];
  let current: QuizQuestion | undefined;
  let part: keyof QuizQuestion = "question";
  let fenced = false;
  for (const line of content.replace(/\r\n?/g, "\n").split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    const label = !fenced && line.match(/^\s*(?:#{1,6}\s+)?(?:\d+[.)、]\s*|[-*]\s+)?(?:\*\*)?(问(?:题)?|答(?:案)?|question|answer|Q|A)\s*\d*\s*[：:]\s*(?:\*\*)?\s*(.*)$/i);
    if (label) {
      if (/^(问|question|q)/i.test(label[1]!)) {
        if (current) questions.push(current);
        let question = label[2]!;
        // Older output wraps the entire question, rather than only its label.
        if (question.endsWith("**") && (question.match(/\*\*/g)?.length ?? 0) % 2 === 1) question = question.slice(0, -2);
        current = { question, answer: "" };
        part = "question";
      } else if (current) {
        current.answer = label[2]!;
        part = "answer";
      }
    } else if (current) current[part] += `\n${line}`;
  }
  if (current) questions.push(current);
  return questions.map(({ question, answer }) => ({ question: question.trim(), answer: answer.trim() }))
    .filter(({ question, answer }) => question && answer);
}
