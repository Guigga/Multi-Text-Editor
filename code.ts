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

figma.showUI(__html__, { width: 340, height: 400 });

function findTopLevelFrame(node: BaseNode): FrameNode | null {
  let parent = node.parent;
  let highestFrame: FrameNode | null = null;

  while (parent && parent.type !== 'PAGE') {
    if (parent.type === 'FRAME') {
      highestFrame = parent;
    }
    parent = parent.parent;
  }
  
  return highestFrame;
}

function processSelection() {
  const selectedNodes = figma.currentPage.selection;
  
  // --- Lógica para Textos (quase igual a antes) ---
  const selectedTextNodes = selectedNodes.filter(node => node.type === 'TEXT') as TextNode[];
  const organizedTextNodes: OrganizedTextNodes = {};
  if (selectedTextNodes.length > 0) {
    for (const textNode of selectedTextNodes) {
      const topLevelFrame = findTopLevelFrame(textNode);
      if (topLevelFrame) {
        const frameId = topLevelFrame.id;
        const frameName = topLevelFrame.name;
        if (!organizedTextNodes[frameId]) {
          organizedTextNodes[frameId] = { frameName: frameName, textNodes: [] };
        }
        organizedTextNodes[frameId].textNodes.push({ nodeId: textNode.id, characters: textNode.characters });
      }
    }
  }

  // --- NOVA LÓGICA para Frames ---
  const selectedFrameNodes = selectedNodes.filter(node => node.type === 'FRAME') as FrameNode[];
  const frameData: FrameNodeInfo[] = [];
  if (selectedFrameNodes.length > 0) {
    for (const frameNode of selectedFrameNodes) {
      frameData.push({
        nodeId: frameNode.id,
        name: frameNode.name
      });
    }
  }

  // Envia AMBOS os conjuntos de dados para a UI
  figma.ui.postMessage({ 
    type: 'selectionChange', 
    textData: organizedTextNodes, 
    frameData: frameData 
  });
}

processSelection();
figma.on('selectionchange', processSelection);

figma.ui.onmessage = async (msg) => {
  if (msg.type === 'apply-changes') {
    for (const change of msg.data) {
      const node = await figma.getNodeByIdAsync(change.nodeId);

      if (node && node.type === 'TEXT') {
        await figma.loadFontAsync(node.fontName as FontName);
        node.characters = change.newText;
      }
    }
    figma.notify("Textos atualizados!");
  }

  if (msg.type === 'apply-frame-name-changes') {
    for (const change of msg.data) {
      const node = await figma.getNodeByIdAsync(change.nodeId);
      if (node && node.type === 'FRAME') {
        node.name = change.newName;
      }
    }
    figma.notify("Nomes dos frames atualizados!");
  }

  if (msg.type === 'cancel') {
    figma.closePlugin();
  }
};