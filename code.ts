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

function findTopLevelFrame(node: BaseNode): FrameNode | null {
  let parent = node.parent;
  let highestFrame: FrameNode | null = null;
  while (parent && parent.type !== 'PAGE') {
    if (parent.type === 'FRAME') highestFrame = parent;
    parent = parent.parent;
  }
  return highestFrame;
}

async function safeLoadFontForTextNode(node: TextNode) {
  try {
    if ((node.fontName as any) === figma.mixed) {
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
        }
      }
    } else {
      await figma.loadFontAsync(node.fontName as FontName);
    }
  } catch (err) {
    try {
      await figma.loadFontAsync(node.fontName as FontName);
    } catch (e) {
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
      const frameId = '__NO_FRAME__';
      if (!organizedTextNodes[frameId]) organizedTextNodes[frameId] = { frameName: 'Page (no frame)', textNodes: [] };
      organizedTextNodes[frameId].textNodes.push({ nodeId: textNode.id, characters: textNode.characters });
    }
  }

  const selectedFrameNodes = selectedNodes.filter(n => n.type === 'FRAME') as FrameNode[];
  const frameData: FrameNodeInfo[] = selectedFrameNodes.map(f => ({ nodeId: f.id, name: f.name }));

  figma.ui.postMessage({ type: 'selectionChange', textData: organizedTextNodes, frameData });
}

processSelection();
figma.on('selectionchange', processSelection);

function navigateAndNotify(newIndex: number, selectNode: boolean = false) {
  currentIndex = newIndex;
  const node = foundNodes[currentIndex];
  if (!node) {
    figma.ui.postMessage({ type: 'search-result', count: 0, index: -1 });
    return;
  }

  if (node.type !== 'TEXT') {
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

      lastChangeSet = [{ nodeId: node.id, originalCharacters: originalText, type: 'TEXT' }];

      node.characters = newText;

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
      for (const node of matches) {
        const originalText = node.characters;
        const newText = originalText.replace(regex, msg.replaceText || '');
        changesToUndo.push({ nodeId: node.id, originalCharacters: originalText, type: 'TEXT' });

        await safeLoadFontForTextNode(node);
        node.characters = newText;
      }

      lastChangeSet = changesToUndo;

      foundNodes = [];
      currentIndex = -1;

      figma.ui.postMessage({ type: 'replace-success', count: changesToUndo.length, allReplaced: true });
      return;
    }

    if (msg.type === 'apply-changes') {
      const data: Array<{ nodeId: string; newText: string }> = msg.data || [];
      if (data.length === 0) return;

      const changes: ChangeLog[] = [];

      for (const change of data) {
        const node = await figma.getNodeByIdAsync(change.nodeId);
        if (node && node.type === 'TEXT') {
          changes.push({ nodeId: node.id, originalCharacters: (node as TextNode).characters, type: 'TEXT' });
        }
      }

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
    figma.ui.postMessage({ type: 'plugin-error', message: String(err) });
  }
};
