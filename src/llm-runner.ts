import fs from 'fs';
import path from 'path';
import {
    ASSISTANT_NAME,
    LLM_MODEL,
    NVIDIA_API_KEY,
    NVIDIA_API_URL,
} from './config.js';
import { logger } from './logger.js';
import { RegisteredGroup } from './types.js';
import { ContainerInput, ContainerOutput } from './container-runner.js';
import { resolveGroupFolderPath } from './group-folder.js';

export async function runLlmAgent(
    group: RegisteredGroup,
    input: ContainerInput,
    onProcess: (proc: any, containerName: string) => void,
    onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<ContainerOutput> {
    const startTime = Date.now();
    const groupDir = resolveGroupFolderPath(group.folder);

    logger.info(
        { group: group.name, model: LLM_MODEL },
        'Executing LLM agent call'
    );

    // Read current context from the folder (philosophy: storage is truth)
    // NanoClaw uses CLAUDE.md for primary memory.
    let systemPrompt = `You are ${ASSISTANT_NAME}, a personal AI assistant. You are running in a lightweight environment designed for a single user.`;

    const claudeMdPath = path.join(groupDir, 'CLAUDE.md');
    if (fs.existsSync(claudeMdPath)) {
        try {
            const content = fs.readFileSync(claudeMdPath, 'utf-8');
            systemPrompt += `\n\nExisting memory from CLAUDE.md:\n${content}`;
        } catch (err) {
            logger.error({ err }, 'Failed to read CLAUDE.md');
        }
    }

    // Also include the global CLAUDE.md if it exists
    const globalMdPath = path.join(process.cwd(), 'groups', 'global', 'CLAUDE.md');
    if (fs.existsSync(globalMdPath)) {
        try {
            const content = fs.readFileSync(globalMdPath, 'utf-8');
            systemPrompt += `\n\nGlobal context from global CLAUDE.md:\n${content}`;
        } catch (err) {
            logger.error({ err }, 'Failed to read global CLAUDE.md');
        }
    }

    try {
        const messages = [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: input.prompt },
        ];

        const response = await fetch(NVIDIA_API_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${NVIDIA_API_KEY}`,
            },
            body: JSON.stringify({
                model: LLM_MODEL,
                messages: messages,
                temperature: 0.7,
                top_p: 1,
                max_tokens: 4096,
                stream: !!onOutput,
            }),
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`NVIDIA NIM API error (${response.status}): ${errorText}`);
        }

        if (onOutput && response.body) {
            // Handle streaming response
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let fullContent = '';
            let resultCalled = false;

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                const chunk = decoder.decode(value, { stream: true });
                const lines = chunk.split('\n');

                for (const line of lines) {
                    if (line.startsWith('data: ') && line !== 'data: [DONE]') {
                        try {
                            const json = JSON.parse(line.trim().slice(6));
                            const content = json.choices[0]?.delta?.content || '';
                            if (content) {
                                fullContent += content;
                                await onOutput({
                                    status: 'success',
                                    result: content,
                                });
                                resultCalled = true;
                            }
                        } catch (err) {
                            logger.debug({ err, line }, 'Failed to parse streaming chunk');
                        }
                    }
                }
            }

            // Final completion marker for NanoClaw
            if (resultCalled) {
                await onOutput({
                    status: 'success',
                    result: null, // Signals completion
                });
            }

            return {
                status: 'success',
                result: fullContent,
            };

        } else {
            // Regular completion
            const json: any = await response.json();
            const resultText = json.choices[0]?.message?.content || '';

            return {
                status: 'success',
                result: resultText,
            };
        }
    } catch (err) {
        logger.error({ group: group.name, err }, 'LLM runner failed');
        const errorMessage = err instanceof Error ? err.message : String(err);
        return {
            status: 'error',
            result: null,
            error: errorMessage,
        };
    }
}
