/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { registerSingleton, InstantiationType } from '../../../../../../platform/instantiation/common/extensions.js';
import { ILlmWikiAdapterService } from './llmWikiAdapterTypes.js';
import { LlmWikiAdapterServiceImpl } from './llmWikiAdapterService.js';

// 单向同步适配器：llm_wiki 文章 → Sarosis WikiTag library。
// 独立注册文件，不污染 agentStudio.contribution.ts，保持自包含。
registerSingleton(ILlmWikiAdapterService, LlmWikiAdapterServiceImpl, InstantiationType.Delayed);
