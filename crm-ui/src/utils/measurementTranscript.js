const NUMBER_WORDS = new Map([
  ["две тысячи семьсот", "2700"],
  ["три тысячи", "3000"],
  ["четыре тысячи", "4000"],
  ["четыре тысячи пятьсот", "4500"],
  ["пять тысяч", "5000"],
  ["шесть тысяч", "6000"],
  ["шесть тысяч пятьсот", "6500"],
]);

const RULES = [
  {
    category: "product",
    match: /(?:зеркал[оа]|зеркальное полотно)/i,
    value: (text) => {
      if (/(?:в|с)\s+рам(?:е|ой)|рамочн/i.test(text)) return "Зеркало в раме";
      return "Зеркало";
    },
    label: "Изделие",
  },
  {
    category: "product",
    match: /(?:душевая|душевое ограждение|душевая перегородка)/i,
    value: (text) => (/раздвижн/i.test(text) ? "Душевое ограждение, раздвижное" : "Душевое ограждение"),
    label: "Изделие",
  },
  {
    category: "lighting",
    match: /(?:подсветк\w*|светодиод\w*)/i,
    value: (text) => {
      if (/лицев\w*/i.test(text)) return "Лицевая";
      if (/контурн\w*|фонов\w*|задн\w*/i.test(text)) return "Контурная (фоновая)";
      if (/без\s+подсвет/i.test(text)) return "Нет";
      return "Есть, тип нужно уточнить";
    },
    label: "Подсветка",
  },
  {
    category: "light_temperature",
    match: /(?:\b\d{4}\s*(?:к|кельвин\w*))|(?:две тысячи семьсот|три тысячи|четыре тысячи(?: пятьсот)?|пять тысяч|шесть тысяч(?: пятьсот)?)\s*(?:к|кельвин\w*)/i,
    value: (text) => {
      const digits = text.match(/\b(\d{4})\s*(?:к|кельвин\w*)/i)?.[1];
      if (digits) return `${digits} К`;
      const words = [...NUMBER_WORDS.entries()].find(([phrase]) => text.toLowerCase().includes(phrase));
      return words ? `${words[1]} К` : "Нужно уточнить";
    },
    label: "Температура света",
  },
  {
    category: "control",
    match: /(?:сенсор\w*|управлен\w*|выключател\w*|кнопк\w*|взмах\w*)/i,
    value: (text) => {
      if (/сенсор\w*/i.test(text)) return "Сенсорное";
      if (/взмах\w*/i.test(text)) return "Взмахом руки";
      if (/кнопк\w*/i.test(text)) return "Кнопка";
      if (/выключател\w*/i.test(text)) return "Настенный выключатель";
      return "Нужно уточнить";
    },
    label: "Управление",
  },
  {
    category: "heating",
    match: /(?:подогрев\w*|антизапотеван\w*)/i,
    value: (text) => (/без\s+(?:подогрев|антизапотеван)/i.test(text) ? "Нет" : "Есть"),
    label: "Подогрев",
  },
  {
    category: "frame",
    match: /(?:рам\w*|профил\w*)/i,
    value: (text) => {
      if (/без\s+рам/i.test(text)) return "Нет";
      const color = text.match(/(?:цвет\s+)?(черн\w*|бел\w*|золот\w*|серебр\w*|хром\w*|бронз\w*)/i)?.[1];
      return color ? `Есть, цвет ${color.toLowerCase()}` : "Есть, параметры нужно уточнить";
    },
    label: "Рама",
  },
  {
    category: "glass",
    match: /(?:стекл\w*|закал[её]н\w*)/i,
    value: (text) => {
      const thickness = text.match(/\b(\d{1,2})\s*(?:мм|миллиметр\w*)/i)?.[1];
      const tempered = /закал[её]н\w*/i.test(text) ? "закалённое" : "";
      return [tempered, thickness ? `${thickness} мм` : ""].filter(Boolean).join(", ") || "Параметры нужно уточнить";
    },
    label: "Стекло",
  },
  {
    category: "shape",
    match: /(?:кругл\w*|овал\w*|прямоугольн\w*|арочн\w*|фигурн\w*)/i,
    value: (text) => {
      const shape = [
        [/кругл\w*/i, "Круглая"],
        [/овал\w*/i, "Овальная"],
        [/прямоугольн\w*/i, "Прямоугольная"],
        [/арочн\w*/i, "Арочная"],
        [/фигурн\w*/i, "Фигурная"],
      ].find(([pattern]) => pattern.test(text));
      return shape?.[1] || "Нужно уточнить";
    },
    label: "Форма",
  },
  {
    category: "dimensions",
    match: /\b\d{2,4}\s*(?:[xх×]|на)\s*\d{2,4}(?:\s*мм)?/i,
    value: (text) => {
      const dimensions = text.match(/\b(\d{2,4})\s*(?:[xх×]|на)\s*(\d{2,4})(?:\s*мм)?/i);
      return dimensions ? `${dimensions[1]} × ${dimensions[2]} мм` : "Нужно уточнить";
    },
    label: "Размер",
  },
  {
    category: "mounting",
    match: /(?:креп[её]ж\w*|креплен\w*|кле\w*|подвес\w*|дюбел\w*|профил\w*)/i,
    value: (text) => {
      if (/кле\w*/i.test(text)) return "На клей";
      if (/подвес\w*/i.test(text)) return "На подвесы";
      if (/дюбел\w*/i.test(text)) return "На дюбели";
      if (/профил\w*/i.test(text)) return "На профиль";
      return "Способ нужно уточнить";
    },
    label: "Крепление",
  },
];

function createItem(category, text, source) {
  return {
    id: globalThis.crypto?.randomUUID?.() || `note-${Date.now()}-${Math.random()}`,
    category,
    text,
    source,
  };
}

function splitTranscript(value) {
  return String(value || "")
    .replace(/\s+(?:следующий пункт|новый пункт|дальше|далее)\s*[:,.-]?\s*/gi, "\n")
    .replace(/(?:^|\s)(?:первый|первое|второй|второе|третий|третье|четв[её]ртый|четв[её]ртое|пятый|пятое)\s+пункт\s*[:,.-]?\s*/gi, "\n")
    .replace(/\s+-\s+/g, "\n")
    .split(/\n|[.!?;]+/)
    .map((part) => part.replace(/^\s*[,.:;-]+|\s+/g, " ").trim())
    .filter(Boolean);
}

export function packageMeasurementTranscript(value) {
  const source = String(value || "").trim();
  if (!source) return [];

  const matches = RULES.filter((rule) => rule.match.test(source));
  const structured = [];
  for (const rule of matches) {
    if (structured.some((item) => item.category === rule.category)) continue;
    structured.push(createItem(rule.category, `${rule.label}: ${rule.value(source)}`, source));
  }
  if (structured.length) {
    const unmatchedNotes = splitTranscript(source)
      .filter((part) => !RULES.some((rule) => rule.match.test(part)))
      .map((text) => createItem("note", `Примечание: ${text.charAt(0).toUpperCase()}${text.slice(1)}`, source));
    return [...structured, ...unmatchedNotes];
  }

  return splitTranscript(source).map((text) => createItem(
    "note",
    `Примечание: ${text.charAt(0).toUpperCase()}${text.slice(1)}`,
    source,
  ));
}

export function mergeMeasurementSpecifications(current, incoming) {
  const next = [...current];
  for (const item of incoming) {
    const existingIndex = item.category && item.category !== "note"
      ? next.findIndex((candidate) => typeof candidate !== "string" && candidate.category === item.category)
      : -1;
    if (existingIndex >= 0) next[existingIndex] = { ...next[existingIndex], ...item, id: next[existingIndex].id };
    else next.push(item);
  }
  return next;
}
