import { randomInt, createHash } from 'crypto';

// Real image URLs from public image APIs (Unsplash, Picsum, etc.)
const IMAGE_CATEGORIES = {
  traffic_lights: ['https://images.unsplash.com/photo-1558618666-fcd25c85f82e?w=200', 'https://images.unsplash.com/photo-1494516181920-8a3c79cd8b8a?w=200'],
  bicycles: ['https://images.unsplash.com/photo-1485965120184-e220f721d03e?w=200', 'https://images.unsplash.com/photo-1532298229144-0ec0c57515c7?w=200'],
  buses: ['https://images.unsplash.com/photo-1570125909232-eb263c188f7e?w=200', 'https://images.unsplash.com/photo-1544620347-c4fd4a3d5957?w=200'],
  crosswalks: ['https://images.unsplash.com/photo-1569336415962-a4bd9f69cd83?w=200'],
  cars: ['https://images.unsplash.com/photo-1494976388531-d1058494cdd8?w=200', 'https://images.unsplash.com/photo-1503376780353-7e6692767b70?w=200'],
  cats: ['https://images.unsplash.com/photo-1514888286974-6c03e2ca1dba?w=200', 'https://images.unsplash.com/photo-1573865526739-10659fec78a5?w=200'],
  dogs: ['https://images.unsplash.com/photo-1587300003388-59208cc962cb?w=200', 'https://images.unsplash.com/photo-1543466835-00a7907e9de1?w=200'],
  birds: ['https://images.unsplash.com/photo-1444464666168-49d633b86797?w=200', 'https://images.unsplash.com/photo-1522926193341-e9ffd686c60f?w=200'],
  trees: ['https://images.unsplash.com/photo-1441974231531-c6227db76b6e?w=200', 'https://images.unsplash.com/photo-1502082553048-f009c37129b9?w=200'],
  flowers: ['https://images.unsplash.com/photo-1490750967868-88aa4f1e0096?w=200', 'https://images.unsplash.com/photo-1416879595882-3373a0480b5b?w=200'],
  fruits: ['https://images.unsplash.com/photo-1619566636858-adf3ef46400b?w=200', 'https://images.unsplash.com/photo-1490474418585-ba9bad8fd0ea?w=200'],
  chairs: ['https://images.unsplash.com/photo-1506439773649-6e0eb8cfb237?w=200'],
  tables: ['https://images.unsplash.com/photo-1530018607912-eff2daa1bac4?w=200'],
  bridges: ['https://images.unsplash.com/photo-1513635269975-59663e0ac1ad?w=200'],
  boats: ['https://images.unsplash.com/photo-1544551763-46a013bb70d5?w=200'],
  mountains: ['https://images.unsplash.com/photo-1464822759023-fed622ff2c3b?w=200'],
  airplanes: ['https://images.unsplash.com/photo-1436491865332-7a61a109cc05?w=200', 'https://images.unsplash.com/photo-1474302770737-173ee21bab63?w=200'],
  clocks: ['https://images.unsplash.com/photo-1524592094714-0f0654e20314?w=200', 'https://images.unsplash.com/photo-1508057198894-247b23fe5ade?w=200'],
  umbrellas: ['https://images.unsplash.com/photo-1559695338-0537f7a5a99a?w=200', 'https://images.unsplash.com/photo-1471995458065-3b0ad063d1d1?w=200'],
  mountains2: ['https://images.unsplash.com/photo-1506905925346-21bda4d32df4?w=200'],
  horses: ['https://images.unsplash.com/photo-1553284965-83fd3e82fa5a?w=200', 'https://images.unsplash.com/photo-1523875194681-bedd468c58bf?w=200'],
  elephants: ['https://images.unsplash.com/photo-1557050543-4d5f4e07ef76?w=200', 'https://images.unsplash.com/photo-1547970810-dc1eac37d174?w=200'],
  pizzas: ['https://images.unsplash.com/photo-1513104890138-7c749659a591?w=200', 'https://images.unsplash.com/photo-1565299624946-b28f40a0ae38?w=200'],
  coffee: ['https://images.unsplash.com/photo-1509042239860-f550ce710b93?w=200', 'https://images.unsplash.com/photo-1495474472287-4d71bcdd2085?w=200'],
  laptops: ['https://images.unsplash.com/photo-1496181133206-80ce9b88a853?w=200', 'https://images.unsplash.com/photo-1517336714731-489689fd1ca8?w=200'],
  shoes: ['https://images.unsplash.com/photo-1542291026-7eec264c27ff?w=200', 'https://images.unsplash.com/photo-1549298916-b41d501d3772?w=200'],
  books: ['https://images.unsplash.com/photo-1544716278-ca5e3f4abd8c?w=200', 'https://images.unsplash.com/photo-1512820790803-83ca734da794?w=200'],
  clocks2: ['https://images.unsplash.com/photo-1495364141860-b0d03eccd065?w=200'],
};

const ALL_IMAGES = Object.values(IMAGE_CATEGORIES).flat();

export interface ChallengeData {
  question: string;
  data: any;
  answerHash: string;
}

function hashAnswer(answer: string): string {
  return createHash('sha256').update(answer.trim().toLowerCase()).digest('hex');
}

// 1. Math Challenge
export function generateMathChallenge(difficulty: string): ChallengeData {
  let a: number, b: number, answer: number, question: string;
  
  if (difficulty === 'easy') {
    a = randomInt(1, 10);
    b = randomInt(1, 10);
    answer = a + b;
    question = `What is ${a} + ${b}?`;
  } else if (difficulty === 'medium') {
    a = randomInt(10, 50);
    b = randomInt(5, 20);
    answer = a - b;
    question = `What is ${a} − ${b}?`;
  } else {
    a = randomInt(2, 12);
    b = randomInt(2, 12);
    answer = a * b;
    question = `What is ${a} × ${b}?`;
  }

  const options = shuffleArray([
    answer.toString(),
    (answer + randomInt(1, 9)).toString(),
    (answer - randomInt(1, 9)).toString(),
    (answer + randomInt(-4, 4)).toString(),
  ].filter((v, i, arr) => arr.indexOf(v) === i));
  while (options.length < 2) options.push(String(randomInt(1, 50)));

  return {
    question,
    data: { render: 'options', options },
    answerHash: hashAnswer(answer.toString()),
  };
}

// 2. Image Selection Challenge — pick ALL images of one category
function buildImagePool(
  targetCategory: string,
  numTargets: number,
  numDistractors: number
): { images: string[]; correctIndices: number[]; category: string } {
  const targetImages = IMAGE_CATEGORIES[targetCategory as keyof typeof IMAGE_CATEGORIES];
  const distractors = ALL_IMAGES.filter(img => !targetImages.includes(img));
  const selectedTargets = shuffleArray(targetImages).slice(0, numTargets);
  const selectedDistractors = shuffleArray(distractors).slice(0, numDistractors);
  const allImages = shuffleArray([...selectedTargets, ...selectedDistractors]);
  const correctIndices = allImages.reduce((acc, img, idx) => {
    if (selectedTargets.includes(img)) acc.push(idx);
    return acc;
  }, [] as number[]);
  return { images: allImages, correctIndices, category: targetCategory };
}

export function generateImageSelectChallenge(difficulty: string): ChallengeData {
  const categories = Object.keys(IMAGE_CATEGORIES);
  const targetCategory = categories[randomInt(0, categories.length)];
  const numTargets = difficulty === 'easy' ? 2 : difficulty === 'medium' ? 3 : 4;
  const numDistractors = difficulty === 'easy' ? 4 : difficulty === 'medium' ? 5 : 6;
  const pool = buildImagePool(targetCategory, numTargets, numDistractors);
  const categoryName = targetCategory.replace('_', ' ');

  return {
    question: `Select all images containing ${categoryName}`,
    data: { images: pool.images, category: pool.category, render: 'image-grid' },
    answerHash: hashAnswer(pool.correctIndices.sort().join(',')),
  };
}

// 2b. Image Single Challenge — click the ONE image of a category
export function generateImageSingleChallenge(difficulty: string): ChallengeData {
  const categories = Object.keys(IMAGE_CATEGORIES);
  const targetCategory = categories[randomInt(0, categories.length)];
  const numTargets = 1;
  const numDistractors = difficulty === 'easy' ? 3 : difficulty === 'medium' ? 4 : 5;
  const pool = buildImagePool(targetCategory, numTargets, numDistractors);
  const categoryName = targetCategory.replace('_', ' ');

  return {
    question: `Click the image of ${categoryName}`,
    data: { images: pool.images, category: pool.category, render: 'image-single' },
    answerHash: hashAnswer(String(pool.correctIndices[0])),
  };
}

// 2c. Image Odd-One-Out Challenge — click the image that doesn't belong
export function generateImageOddChallenge(difficulty: string): ChallengeData {
  const categories = Object.keys(IMAGE_CATEGORIES);
  const oddIdx = randomInt(0, categories.length);
  let sameIdx = randomInt(0, categories.length - 1);
  if (sameIdx >= oddIdx) sameIdx += 1;
  const oddCategory = categories[oddIdx];
  const sameCategory = categories[sameIdx];
  const oddImages = IMAGE_CATEGORIES[oddCategory as keyof typeof IMAGE_CATEGORIES];
  const sameImages = IMAGE_CATEGORIES[sameCategory as keyof typeof IMAGE_CATEGORIES];

  const numSame = difficulty === 'easy' ? 4 : difficulty === 'medium' ? 5 : 5;
  const selectedSame = shuffleArray(sameImages).slice(0, numSame);
  const selectedOdd = shuffleArray(oddImages)[0];
  const allImages = shuffleArray([...selectedSame, selectedOdd]);
  const oddPosition = allImages.indexOf(selectedOdd);

  return {
    question: 'Click the image that does not belong',
    data: { images: allImages, render: 'image-odd' },
    answerHash: hashAnswer(String(oddPosition)),
  };
}

// 3. Emoji Challenge
export function generateEmojiChallenge(difficulty: string): ChallengeData {
  const emojis = ['😀', '❤️', '🌟', '🎉', '🔥', '💎', '🎯', '🚀', '🌈', '⚡', '🎨', '🌸'];
  const target = emojis[randomInt(0, emojis.length)];
  const count = randomInt(2, 5);
  
  // Create a grid with the target emoji
  const grid: string[] = [];
  for (let i = 0; i < count; i++) grid.push(target);
  // Add distractors
  const distractors = emojis.filter(e => e !== target);
  for (let i = 0; i < randomInt(3, 6); i++) {
    grid.push(distractors[randomInt(0, distractors.length)]);
  }
  const shuffled = shuffleArray(grid);
  const options = shuffleArray(['1', '2', '3', '4', '5', '6']);

  return {
    question: `How many ${target} are there?`,
    data: { emojis: shuffled, target, options, render: 'emoji' },
    answerHash: hashAnswer(count.toString()),
  };
}

// 4. Word Challenge
export function generateWordChallenge(difficulty: string): ChallengeData {
  const words = ['apple', 'brave', 'cloud', 'dream', 'eagle', 'flame', 'grace', 'heart', 'ivory', 'jewel'];
  const word = words[randomInt(0, words.length)];
  const scrambled = shuffleArray(word.split('')).join('');
  const options = shuffleArray([word, ...shuffleArray(words.filter(w => w !== word)).slice(0, 3)]);

  return {
    question: `Unscramble this word: ${scrambled.toUpperCase()}`,
    data: { scrambled: scrambled.toUpperCase(), render: 'options', options },
    answerHash: hashAnswer(word),
  };
}

// 5. Logic Challenge
export function generateLogicChallenge(difficulty: string): ChallengeData {
  const sequences = [
    { seq: ['2', '4', '6', '8', '?'], answer: '10', question: 'What comes next?' },
    { seq: ['1', '1', '2', '3', '5', '?'], answer: '8', question: 'What comes next?' },
    { seq: ['A', 'C', 'E', 'G', '?'], answer: 'I', question: 'What comes next?' },
    { seq: ['🔴', '🔵', '🔴', '🔵', '?'], answer: '🔴', question: 'What comes next?' },
  ];
  const seq = sequences[randomInt(0, sequences.length)];

  return {
    question: seq.question,
    data: { sequence: seq.seq, options: generateOptions(seq.answer), render: 'options' },
    answerHash: hashAnswer(seq.answer),
  };
}

// 6. Color Challenge
export function generateColorChallenge(difficulty: string): ChallengeData {
  const colors = ['#ef4444', '#3b82f6', '#22c55e', '#f59e0b', '#8b5cf6', '#ec4899'];
  const colorNames = ['red', 'blue', 'green', 'yellow', 'purple', 'pink'];
  const targetIdx = randomInt(0, colors.length);
  const shuffled = shuffleArray(colors.map((c, i) => ({ color: c, name: colorNames[i] })));

  return {
    question: `Click the ${colorNames[targetIdx]} circle`,
    data: { colors: shuffled.map(s => s.color), render: 'colors' },
    answerHash: hashAnswer(targetIdx.toString()),
  };
}

// 7. Shape Challenge
export function generateShapeChallenge(difficulty: string): ChallengeData {
  const shapes = ['⬛', '🔺', '🔵', '⭐', '💠', '🔶'];
  const shapeNames = ['square', 'triangle', 'circle', 'star', 'diamond', 'hexagon'];
  const targetIdx = randomInt(0, shapes.length);
  const shuffled = shuffleArray(shapes.map((s, i) => ({ shape: s, name: shapeNames[i] })));

  return {
    question: `Find the ${shapeNames[targetIdx]}`,
    data: { shapes: shuffled.map(s => s.shape), render: 'shapes' },
    answerHash: hashAnswer(targetIdx.toString()),
  };
}

// 8. Memory Challenge
export function generateMemoryChallenge(difficulty: string): ChallengeData {
  const gridSize = difficulty === 'easy' ? 9 : difficulty === 'medium' ? 12 : 16;
  const numHighlight = difficulty === 'easy' ? 3 : difficulty === 'medium' ? 4 : 5;
  
  const tiles = Array.from({ length: gridSize }, (_, i) => ({ highlight: false }));
  const highlightIndices = shuffleArray(Array.from({ length: gridSize }, (_, i) => i)).slice(0, numHighlight);
  highlightIndices.forEach(idx => { tiles[idx].highlight = true; });

  return {
    question: 'Remember the highlighted tiles, then click them',
    data: { tiles, render: 'memory' },
    answerHash: hashAnswer(highlightIndices.sort().join(',')),
  };
}

// 9. Text Challenge (distorted)
export function generateTextChallenge(difficulty: string): ChallengeData {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const length = difficulty === 'easy' ? 4 : difficulty === 'medium' ? 5 : 6;
  let text = '';
  for (let i = 0; i < length; i++) {
    text += chars[randomInt(0, chars.length)];
  }

  return {
    question: 'Type the text you see',
    data: { text, rotation: randomInt(-15, 15), color: `hsl(${randomInt(0, 360)}, 70%, 40%)`, render: 'text' },
    answerHash: hashAnswer(text.toLowerCase()),
  };
}

// Helper functions
function shuffleArray<T>(arr: T[]): T[] {
  const shuffled = [...arr];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = randomInt(0, i + 1);
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

function generateOptions(correct: string): string[] {
  const options = [correct];
  while (options.length < 4) {
    const fake = (parseInt(correct) + randomInt(-5, 5) + 1).toString();
    if (!options.includes(fake) && fake !== correct) options.push(fake);
  }
  return shuffleArray(options);
}

// Main challenge generator
export function generateChallenge(type: string, difficulty: string): ChallengeData {
  switch (type) {
    case 'math': return generateMathChallenge(difficulty);
    case 'image-select': return generateImageSelectChallenge(difficulty);
    case 'image-single': return generateImageSingleChallenge(difficulty);
    case 'image-odd': return generateImageOddChallenge(difficulty);
    case 'emoji': return generateEmojiChallenge(difficulty);
    case 'word': return generateWordChallenge(difficulty);
    case 'logic': return generateLogicChallenge(difficulty);
    case 'color': return generateColorChallenge(difficulty);
    case 'shape': return generateShapeChallenge(difficulty);
    case 'memory': return generateMemoryChallenge(difficulty);
    case 'text': return generateTextChallenge(difficulty);
    default: return generateMathChallenge(difficulty);
  }
}

export const CHALLENGE_TYPES = [
  'math', 'image-select', 'image-single', 'image-odd', 'emoji',
  'word', 'logic', 'color', 'shape', 'memory', 'text',
];
