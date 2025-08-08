// code.ts
// Plugin main thread - reescrito para ser mais robusto e corrigir bugs.
// Funcionalidades:
// - Detecta seleção (textos e frames) e envia estrutura organizada para a UI
// - Aplica mudanças em textos (com load de fontes seguro) e nomes de frames
// - Find / navigate / replace single / replace all
// - Undo da última alteração (texto(s) ou frame names)
// - Mantém último conjunto de alterações em memória para undo
//
// Observações de melhoria:
// - Tratamento seguro de fontes: tenta carregar font único e, se "mixed", carrega por range
// - Escapa termos de busca para evitar regex injetado
// - Depois de aplicar mudanças, reenvia seleção atual para UI (fonte da verdade atualizada)

interface ChangeLog {
  nodeId: string;
  originalCharacters: string;
  type: 'TEXT' | 'FRAME';
}

interface TextNodeInfo {
  nodeId: string;
  characters: string;
}

interface OrganizedTextNodes {
  [frameId: string]: {
    frameName: string;
    textNodes: TextNodeInfo[];
  }
}

interface FrameNodeInfo {
  nodeId: string;
  name: string;
}

let foundNodes: SceneNode[] = [];
let currentIndex: number = -1;
let lastChangeSet: ChangeLog[] = [];

figma.showUI(__html__, { width: 340, height: 560 });

// Helper: sobe até o FRAME mais alto (top-level frame) antes do PAGE
function findTopLevelFrame(node: BaseNode): FrameNode | null {
  let parent = node.parent;
  let highestFrame: FrameNode | null = null;
  while (parent && parent.type !== 'PAGE') {
    if (parent.type === 'FRAME') highestFrame = parent;
    parent = parent.parent;
  }
  return highestFrame;
}

// Safe font loader: tenta carregar font direto; se falhar, carrega por ranges
async function safeLoadFontForTextNode(node: TextNode) {
  try {
    // node.fontName pode ser FontName ou "MIXED"
    if ((node.fontName as any) === figma.mixed) {
      // carrega por ranges únicos
      const len = node.characters.length;
      const fonts = new Map<string, FontName>();
      for (let i = 0; i < len; i++) {
        try {
          const f = node.getRangeFontName(i, i + 1) as FontName;
          const key = `${f.family}-${f.style}`;
          if (!fonts.has(key)) {
            fonts.set(key, f);
            await figma.loadFontAsync(f);
          }
        } catch (e) {
          // ignorar pequenas falhas de index
        }
      }
    } else {
      await figma.loadFontAsync(node.fontName as FontName);
    }
  } catch (err) {
    // fallback: tenta carregar como FontName (algumas vezes a propriedade vem diferente)
    try {
      await figma.loadFontAsync(node.fontName as FontName);
    } catch (e) {
      // Não podemos fazer mais. Deixa o erro invisível para o usuário, mas evita crash.
      console.warn('safeLoadFontForTextNode: não conseguiu carregar fonte', e);
    }
  }
}

function processSelection() {
  const selectedNodes = figma.currentPage.selection;
  const selectedTextNodes = selectedNodes.filter(n => n.type === 'TEXT') as TextNode[];
  const organizedTextNodes: OrganizedTextNodes = {};

  for (const textNode of selectedTextNodes) {
    const topLevelFrame = findTopLevelFrame(textNode);
    if (topLevelFrame) {
      const frameId = topLevelFrame.id;
      if (!organizedTextNodes[frameId]) {
        organizedTextNodes[frameId] = { frameName: topLevelFrame.name, textNodes: [] };
      }
      organizedTextNodes[frameId].textNodes.push({ nodeId: textNode.id, characters: textNode.characters });
    } else {
      // se não tem frame (texto solto na página), agrupamos por id da própria página (ou "root")
      const frameId = '__NO_FRAME__';
      if (!organizedTextNodes[frameId]) organizedTextNodes[frameId] = { frameName: 'Page (no frame)', textNodes: [] };
      organizedTextNodes[frameId].textNodes.push({ nodeId: textNode.id, characters: textNode.characters });
    }
  }

  const selectedFrameNodes = selectedNodes.filter(n => n.type === 'FRAME') as FrameNode[];
  const frameData: FrameNodeInfo[] = selectedFrameNodes.map(f => ({ nodeId: f.id, name: f.name }));

  figma.ui.postMessage({ type: 'selectionChange', textData: organizedTextNodes, frameData });
}

// Inicial
processSelection();
// Atualiza quando seleção muda
figma.on('selectionchange', processSelection);

// Navegação entre resultados encontrados
function navigateAndNotify(newIndex: number, selectNode: boolean = false) {
  currentIndex = newIndex;
  const node = foundNodes[currentIndex];
  if (!node) {
    figma.ui.postMessage({ type: 'search-result', count: 0, index: -1 });
    return;
  }

  // se o node foi deletado ou não é mais texto, filtramos
  if (node.type !== 'TEXT') {
    // refilter
    foundNodes = foundNodes.filter(n => n.type === 'TEXT' && (n as TextNode).characters !== undefined);
    if (foundNodes.length === 0) {
      currentIndex = -1;
      figma.ui.postMessage({ type: 'search-result', count: 0, index: -1 });
      return;
    }
    currentIndex = Math.min(newIndex, foundNodes.length - 1);
  }

  const textNode = foundNodes[currentIndex] as TextNode;
  figma.viewport.scrollAndZoomIntoView([textNode]);
  if (selectNode) figma.currentPage.selection = [textNode];

  figma.ui.postMessage({
    type: 'navigation-update',
    index: currentIndex,
    count: foundNodes.length,
    nodeText: textNode.characters
  });
}

// Escapa string para regex literal
function escapeForRegex(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

figma.ui.onmessage = async (msg) => {
  try {
    if (msg.type === 'find-text') {
      const query = (msg.query || '').trim();
      if (!query) {
        foundNodes = [];
        currentIndex = -1;
        figma.ui.postMessage({ type: 'search-result', count: 0, index: -1 });
        return;
      }

      const escaped = escapeForRegex(query);
      const flags = msg.isCaseSensitive ? 'g' : 'gi';
      const regex = new RegExp(escaped, flags);

      foundNodes = figma.currentPage.findAll(n => {
        if (n.type !== 'TEXT') return false;
        const t = (n as TextNode).characters || '';
        return regex.test(t);
      });

      currentIndex = foundNodes.length > 0 ? 0 : -1;
      if (currentIndex !== -1) navigateAndNotify(currentIndex, false);
      else figma.ui.postMessage({ type: 'search-result', count: 0, index: -1 });
      return;
    }

    if (msg.type === 'navigate') {
      if (foundNodes.length === 0) {
        return;
      }
      let newIndex = currentIndex;
      if (msg.direction === 'next') newIndex = (currentIndex + 1) % foundNodes.length;
      else if (msg.direction === 'prev') newIndex = (currentIndex - 1 + foundNodes.length) % foundNodes.length;
      navigateAndNotify(newIndex, true);
      return;
    }

    if (msg.type === 'replace-single') {
      if (currentIndex === -1 || !foundNodes[currentIndex]) {
        figma.ui.postMessage({ type: 'replace-success', count: 0 });
        return;
      }
      const node = foundNodes[currentIndex] as TextNode;
      const originalText = node.characters;
      const escaped = escapeForRegex(msg.findText || '');
      const regex = new RegExp(escaped, msg.isCaseSensitive ? '' : 'i');

      if (!regex.test(originalText)) {
        figma.ui.postMessage({ type: 'replace-success', count: 0 });
        return;
      }

      await safeLoadFontForTextNode(node);
      const newText = originalText.replace(regex, msg.replaceText || '');

      // registra undo
      lastChangeSet = [{ nodeId: node.id, originalCharacters: originalText, type: 'TEXT' }];

      node.characters = newText;

      // atualiza o foundNodes (atualiza texto localmente)
      foundNodes[currentIndex] = node;

      figma.ui.postMessage({
        type: 'replace-success',
        count: 1,
        updatedNode: { index: currentIndex, count: foundNodes.length, nodeText: node.characters }
      });
      return;
    }

    if (msg.type === 'replace-all') {
      const findText = msg.findText || '';
      if (!findText) {
        figma.ui.postMessage({ type: 'replace-success', count: 0, allReplaced: true });
        return;
      }
      const escaped = escapeForRegex(findText);
      const flags = msg.isCaseSensitive ? 'g' : 'gi';
      const regex = new RegExp(escaped, flags);

      const matches = figma.currentPage.findAll(n => n.type === 'TEXT' && regex.test((n as TextNode).characters || '')) as TextNode[];

      if (matches.length === 0) {
        figma.ui.postMessage({ type: 'replace-success', count: 0, allReplaced: true });
        return;
      }

      const changesToUndo: ChangeLog[] = [];
      // apply in parallel but load fonts per node
      for (const node of matches) {
        const originalText = node.characters;
        const newText = originalText.replace(regex, msg.replaceText || '');
        changesToUndo.push({ nodeId: node.id, originalCharacters: originalText, type: 'TEXT' });

        await safeLoadFontForTextNode(node);
        node.characters = newText;
      }

      lastChangeSet = changesToUndo;

      // limpa busca para evitar inconsistências
      foundNodes = [];
      currentIndex = -1;

      figma.ui.postMessage({ type: 'replace-success', count: changesToUndo.length, allReplaced: true });
      return;
    }

    if (msg.type === 'apply-changes') {
      // msg.data = [ { nodeId, newText } ]
      const data: Array<{ nodeId: string; newText: string }> = msg.data || [];
      if (data.length === 0) return;

      const changes: ChangeLog[] = [];

      // primeiro, coleto os estados originais (para undo)
      for (const change of data) {
        const node = await figma.getNodeByIdAsync(change.nodeId);
        if (node && node.type === 'TEXT') {
          changes.push({ nodeId: node.id, originalCharacters: (node as TextNode).characters, type: 'TEXT' });
        }
      }

      // aplico
      for (const change of data) {
        const node = await figma.getNodeByIdAsync(change.nodeId);
        if (node && node.type === 'TEXT') {
          const textNode = node as TextNode;
          await safeLoadFontForTextNode(textNode);
          textNode.characters = change.newText;
        }
      }

      lastChangeSet = changes;
      figma.notify('Updated texts!');
      // atualiza UI com seleção atualizada
      processSelection();
      figma.ui.postMessage({ type: 'apply-success', count: data.length });
      return;
    }

    if (msg.type === 'apply-frame-name-changes') {
      const data: Array<{ nodeId: string; newName: string }> = msg.data || [];
      if (data.length === 0) return;

      const changes: ChangeLog[] = [];
      for (const change of data) {
        const node = await figma.getNodeByIdAsync(change.nodeId);
        if (node && node.type === 'FRAME') {
          changes.push({ nodeId: node.id, originalCharacters: (node as FrameNode).name, type: 'FRAME' });
        }
      }

      for (const change of data) {
        const node = await figma.getNodeByIdAsync(change.nodeId);
        if (node && node.type === 'FRAME') {
          (node as FrameNode).name = change.newName;
        }
      }

      lastChangeSet = changes;
      figma.notify('Updated frame names!');
      processSelection();
      figma.ui.postMessage({ type: 'apply-success', count: data.length });
      return;
    }

    if (msg.type === 'undo-last-change') {
      if (lastChangeSet.length === 0) {
        figma.ui.postMessage({ type: 'hide-undo' });
        return;
      }

      for (const change of lastChangeSet) {
        const node = await figma.getNodeByIdAsync(change.nodeId);
        if (!node) continue;
        if (change.type === 'TEXT' && node.type === 'TEXT') {
          await safeLoadFontForTextNode(node as TextNode);
          (node as TextNode).characters = change.originalCharacters;
        } else if (change.type === 'FRAME' && node.type === 'FRAME') {
          (node as FrameNode).name = change.originalCharacters;
        }
      }

      const count = lastChangeSet.length;
      lastChangeSet = [];
      figma.notify(`${count} ${count > 1 ? 'changes undone' : 'change undone'}!`);
      // envia nova seleção para UI para garantir que UI re-renderize com o estado correto
      processSelection();
      figma.ui.postMessage({ type: 'undo-complete' });
      return;
    }

    if (msg.type === 'cancel') {
      figma.closePlugin();
      return;
    }

  } catch (err) {
    console.error('plugin error:', err);
    // sempre tente enviar um aviso para UI
    figma.ui.postMessage({ type: 'plugin-error', message: String(err) });
  }
};
