/** Shared CLI boundary; importing a role is safe and does not start a model run. */
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { runAgent, type RunAgentInput } from '../../run-agent.ts'
export type AgentDefinition = Pick<RunAgentInput,'identity'|'systemPrompt'|'tools'> & { defaultPrompt: string }
export function createAgent(definition: AgentDefinition) {
  return (prompt = definition.defaultPrompt) => runAgent({...definition,prompt})
}
export async function runCli(moduleUrl: string, definition: AgentDefinition) {
  if (process.argv[1] && moduleUrl === pathToFileURL(resolve(process.argv[1])).href) {
    const result = await createAgent(definition)(process.argv.slice(2).join(' ').trim() || definition.defaultPrompt)
    console.log(result.finalResponse)
  }
}
