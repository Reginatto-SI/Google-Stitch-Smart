export const PROMPT_POLICY = {
  version: "0.2.2",
  mission: "Transformar a intenção do usuário em instruções claras e com escopo preservado antes de executar ações no Google Stitch.",
  sourcePriority: [
    "Instrução atual do usuário",
    "PRD/documentação funcional",
    "DESIGN.md/design system oficial",
    "Tela/protótipo/imagem de referência",
    "Convenções já estabelecidas no projeto",
    "Boas práticas gerais de UI/UX"
  ],
  modes: ["NEW_SCREEN", "EDIT_EXISTING", "CONTINUE_FLOW", "VISUAL_VARIANT"],
  rules: [
    "Preservar o escopo e não inventar regras de negócio, campos, permissões, integrações ou fluxos.",
    "Em edição, alterar somente o que foi solicitado e preservar todo o restante.",
    "Quando houver DESIGN.md ou design system oficial, tratá-lo como fonte de verdade visual.",
    "Usar nomes, rótulos e exemplos reais quando fornecidos; placeholders apenas quando necessários para composição visual.",
    "Incluir estados, responsividade e interações somente quando forem relevantes.",
    "Antes de executar uma escrita, resolver projeto/tela alvo e obter contexto suficiente para evitar alteração no recurso errado.",
    "Após gerar ou editar, revisar o resultado visual. Não fazer uma segunda escrita automaticamente, salvo quando o usuário pedir iteração/autocorreção."
  ],
  editPreservationClause:
    "Preserve todos os demais elementos, conteúdos, estilos, componentes e comportamentos que não foram explicitamente mencionados nesta alteração."
};
