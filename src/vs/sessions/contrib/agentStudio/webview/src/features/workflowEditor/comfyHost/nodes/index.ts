/**
 * nodes - 节点定义汇聚（2026-09-07）。
 *
 * 新增节点：在 comfyHost/nodes/ 下建 <name>Node.ts（defineNode 一体声明），
 * 然后在这里加一行 import 即完成注册（副作用）。不需要再改
 * runNodeOrStage 分发链 / NodeEditorPopup / nodeCard 等接缝。
 * 轻量形态（spec 留 registry 注册文件）：defineNode({ type, run, ... })。
 */
import './animatedEmojiNode.js';
import './providerVideoNode.js';
import './model3DGenNode.js';
import './providerImageNode.js';
import './providerTextNode.js';
import './providerAudioNode.js';
import './weixinStickerCoverNode.js';
import './agentNode.js';
import './taskNode.js';
import './skillNode.js';
import './toolNode.js';
import './promptNode.js';
import './gateNode.js';
import './mergeNode.js';
import './endNode.js';
import './loopNode.js';
import './askUserNode.js';
import './statEmojiNode.js';
import './multiPanelStoryboardNode.js';
import './videoToGifNode.js';
import './videoMatteNode.js';
import './removeBgNode.js';
