export type QuizOption = {
  key: string;
  text: string;
};

export type QuizQuestion = {
  id: string;
  question: string;
  options: QuizOption[];
  correctAnswer?: string;
  explanation?: string;
  answer: string;
};

function cleanText(text: string): string {
  let s = text.trim();
  if (s.startsWith("**") && s.endsWith("**") && s.length >= 4) {
    const inner = s.slice(2, -2);
    if ((inner.match(/\*\*/g) || []).length % 2 === 0) {
      s = inner.trim();
    }
  }
  // Strip trailing unclosed ** (odd number of ** in total and ends with **)
  const count = (s.match(/\*\*/g) || []).length;
  if (count % 2 === 1 && s.endsWith("**")) {
    s = s.slice(0, -2).trim();
  }
  return s;
}

function cleanQuestion(raw: string): string {
  let q = raw.trim();
  // Strip question labels like "问：", "问题：", "Q1:"
  q = q.replace(/^(?:#{1,6}\s+)?(?:(?:\d+|[一二三四五六七八九十]+)[.)、]\s*)?(?:\*\*)?(?:问(?:题)?|question|Q)\s*\d*\s*[：:]\s*(?:\*\*)?/i, "");
  // Strip Markdown header hashes if remaining
  q = q.replace(/^#{1,6}\s+/, "");
  // Strip leading numbers ONLY if followed by dot or punctuation: "1. ", "1、"
  q = q.replace(/^(?:\d+|[一二三四五六七八九十]+)[.)、]\s*/, "");
  return cleanText(q);
}

/**
 * Parses markdown into structured quiz questions.
 * Robustly supports:
 * 1. Multiple-choice questions (A, B, C, D options + Correct Answer + Explanation)
 * 2. Legacy Q&A format (Question + Answer)
 * 3. Cleaning of extraneous markdown artifacts like stray `**`
 */
export function parseQuiz(content: string): QuizQuestion[] {
  const rawList: Array<{
    question: string;
    options: QuizOption[];
    correctAnswer?: string;
    explanation: string;
    rawAnswer: string;
  }> = [];

  let current: {
    question: string;
    options: QuizOption[];
    correctAnswer?: string;
    explanation: string;
    rawAnswer: string;
  } | undefined;

  let currentOption: QuizOption | null = null;
  let mode: "question" | "option" | "answer" | "explanation" = "question";
  let fenced = false;

  const lines = content.replace(/\r\n?/g, "\n").split("\n");

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex]!;
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;

    const trimmed = line.trim();
    if (!trimmed) {
      if (mode === "option") currentOption = null;
      continue;
    }

    // Skip top-level title, e.g. "# 测验名称"
    if (/^#\s+[^#]/.test(line)) {
      continue;
    }

    // Check if line is an answer line
    let isAnswerLine = false;
    let ansBody = "";
    const primaryAnsMatch = line.match(/^\s*(?:[-*]\s+)?(?:\*\*)?(正确答案|答案|答(?:案)?|Correct Answer|Answer)\s*[：:]\s*(?:\*\*)?\s*(.*)$/i);
    if (primaryAnsMatch) {
      isAnswerLine = true;
      ansBody = cleanText(primaryAnsMatch[2]!);
    } else {
      const legacyAMatch = line.match(/^\s*(?:[-*]\s+)?(?:\*\*)?(?:A|答)\s*[：:]\s*(?:\*\*)?\s*(.*)$/i);
      if (legacyAMatch) {
        let hasOptionB = false;
        for (let j = lineIndex + 1; j < lines.length; j++) {
          const aheadLine = lines[j]!.trim();
          if (/^#{1,6}\s+/i.test(aheadLine)) break;
          if (/^\s*(?:[-*]\s+)?(?:\*\*)?B(?:\*\*)?[.)、:：\s]/i.test(aheadLine)) {
            hasOptionB = true;
            break;
          }
        }
        if (!hasOptionB) {
          isAnswerLine = true;
          const colonIdx = line.search(/[：:]/);
          if (colonIdx !== -1) {
            ansBody = cleanText(line.slice(colonIdx + 1));
          }
        }
      }
    }

    const isOptionLine = !isAnswerLine && /^\s*(?:[-*]\s+)?(?:\*\*)?([A-D])(?:\*\*)?[.)、:：\s]\s*(.*)$/i.test(line);
    const isExplanationLine = /^\s*(?:[-*]\s+)?(?:\*\*)?(解析|答案解析|依据|理由|出处|Explanation|Rationale)\s*[：:]\s*(?:\*\*)?\s*(.*)$/i.test(line);

    // 1. Check for Question start
    const qMatch =
      line.match(/^\s*#{2,6}\s*(?:(?:\d+|[一二三四五六七八九十]+)[.)、]\s*)?(?:(?:\*\*)?(?:问(?:题)?|question|Q)\s*\d*\s*[：:]\s*(?:\*\*)?)?\s*(.*)$/i) ||
      line.match(/^\s*(?:\d+|[一二三四五六七八九十]+)[.)、]\s*(?:(?:\*\*)?(?:问(?:题)?|question|Q)\s*\d*\s*[：:]\s*(?:\*\*)?)?\s*(.*)$/i) ||
      line.match(/^\s*(?:\*\*)?(?:问(?:题)?|question|Q)\s*\d*\s*[：:]\s*(?:\*\*)?\s*(.*)$/i);

    if (qMatch && !isOptionLine && !isAnswerLine && !isExplanationLine) {
      const qText = cleanQuestion(qMatch[1] ?? line);
      if (qText) {
        if (current) rawList.push(current);
        current = {
          question: qText,
          options: [],
          correctAnswer: undefined,
          explanation: "",
          rawAnswer: ""
        };
        currentOption = null;
        mode = "question";
        continue;
      }
    }

    if (!current) continue;

    // 2. Check for Option line (A, B, C, D)
    const optMatch = line.match(/^\s*(?:[-*]\s+)?(?:\*\*)?([A-D])(?:\*\*)?[.)、:：\s]\s*(.*)$/i);
    if (optMatch && !isAnswerLine && !isExplanationLine) {
      const key = optMatch[1]!.toUpperCase();
      const text = cleanText(optMatch[2]!);
      currentOption = { key, text };
      current.options.push(currentOption);
      mode = "option";
      continue;
    }

    // 3. Answer line
    if (isAnswerLine) {
      const letterMatch = ansBody.match(/\b([A-D])\b/i) || ansBody.match(/^([A-D])[.)、:：\s]/i);
      if (letterMatch && current.options.length > 0) {
        current.correctAnswer = letterMatch[1]!.toUpperCase();
      }
      current.rawAnswer = ansBody;
      mode = "answer";
      currentOption = null;
      continue;
    }

    // 4. Explanation line
    const expMatch = line.match(/^\s*(?:[-*]\s+)?(?:\*\*)?(解析|答案解析|依据|理由|出处|Explanation|Rationale)\s*[：:]\s*(?:\*\*)?\s*(.*)$/i);
    if (expMatch) {
      current.explanation = cleanText(expMatch[2]!);
      mode = "explanation";
      currentOption = null;
      continue;
    }

    // 5. Continuation lines
    if (mode === "option" && currentOption) {
      currentOption.text += `\n${trimmed}`;
    } else if (mode === "explanation") {
      current.explanation = current.explanation ? `${current.explanation}\n${trimmed}` : trimmed;
    } else if (mode === "answer") {
      current.rawAnswer = current.rawAnswer ? `${current.rawAnswer}\n${trimmed}` : trimmed;
    } else if (mode === "question") {
      current.question += `\n${trimmed}`;
    }
  }

  if (current) {
    rawList.push(current);
  }

  return rawList
    .map((item, index): QuizQuestion => {
      const q = cleanQuestion(item.question);
      let exp = cleanText(item.explanation);
      let rawAns = cleanText(item.rawAnswer);
      let corr = item.correctAnswer;

      if (!corr && rawAns) {
        const letter = rawAns.match(/\b([A-D])\b/i);
        if (letter && item.options.some((o) => o.key === letter[1]!.toUpperCase())) {
          corr = letter[1]!.toUpperCase();
        }
      }

      let unifiedAnswer = rawAns;
      if (item.options.length > 0 && corr) {
        const correctOpt = item.options.find((o) => o.key === corr);
        const optSummary = correctOpt ? `${corr}. ${correctOpt.text}` : corr;
        unifiedAnswer = exp ? `${optSummary}\n\n${exp}` : optSummary;
      } else if (!unifiedAnswer && exp) {
        unifiedAnswer = exp;
      }

      return {
        id: String(index),
        question: q,
        options: item.options,
        correctAnswer: corr,
        explanation: exp,
        answer: unifiedAnswer
      };
    })
    .filter((q) => q.question && (q.options.length > 0 || q.answer));
}
