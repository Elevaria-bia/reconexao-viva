export default {
  async fetch(request, env) {

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        }
      });
    }

    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }

    try {
      const { image, scores } = await request.json();

      if (!image) {
        return new Response(JSON.stringify({ error: 'Imagem não recebida' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      }

      // Total do questionário para contexto
      const total = Object.values(scores || {}).reduce((a, b) => a + Number(b), 0) || 10;

      // Remove prefixo base64 se existir
      const imageData = image.replace(/^data:image\/\w+;base64,/, '');

      // Chama Claude Vision
      const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          max_tokens: 1200,
          messages: [{
            role: 'user',
            content: [
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: 'image/jpeg',
                  data: imageData,
                }
              },
              {
                type: 'text',
                text: `Você é a Bia, criadora do Método Reconexão Facial — especialista em leitura facial com 15 anos de experiência em estética e consciência corporal.

Esta mulher acabou de completar o Mapa de Reconexão. Ela respondeu o questionário e obteve pontuação ${total}/15 (5 = mínima tensão, 15 = máxima tensão acumulada).

Analise esta foto do rosto com olhar clínico, empático e preciso. Observe:

1. MASSETER E MANDÍBULA — há tensão visível? Assimetria? Sinal de bruxismo? O ângulo do maxilar está tenso ou relaxado?
2. REGIÃO DOS OLHOS — inchaço, olheiras, pesadez nas pálpebras, sinal de fadiga ou sistema nervoso sobrecarregado
3. TESTA E SOBRANCELHAS — linhas de tensão habitual, franzimento, tensão na glabela
4. CONTORNO FACIAL — descida de contorno, pesadez, perda de definição por tensão muscular
5. ASSIMETRIA — qual lado carrega mais tensão? Isso revela padrão postural ou emocional
6. EXPRESSÃO EM REPOUSO — o que este rosto comunica quando está quieto? Cansaço, fechamento, leveza, peso?

RETORNE SOMENTE um JSON válido, sem markdown, sem explicações fora do JSON:
{
  "perfil": "Nome poético do perfil desta mulher especificamente (2-4 palavras)",
  "titulo": "Uma frase que captura o que este rosto revela (máx 10 palavras)",
  "lead": "2-3 frases descrevendo o que você observou no rosto DESTA mulher. Seja específica sobre o que viu — não genérica. Mencione a área de maior tensão. Tom: acolhedor, presente, como uma amiga que realmente olhou para ela.",
  "cards": [
    { "title": "O que seu rosto revela", "body": "Observação visual específica sobre tensão identificada" },
    { "title": "Onde a tensão mora", "body": "Área facial de maior acúmulo identificada na foto" },
    { "title": "Seu próximo passo", "body": "Protocolo específico mais urgente para este padrão" }
  ],
  "transform": "2 frases sobre o que esta mulher pode liberar e sentir com acompanhamento individual. Específico para o padrão observado."
}

REGRAS ABSOLUTAS DE LINGUAGEM:
- NUNCA use: anti-envelhecimento, elimine rugas, pareça mais jovem, corrija, conserte, combata
- USE: reconectar, habitar, presença, liberar, amadurecimento, rosto com história, consciência
- Tom: acolhedor, inteligente, como amiga especialista — nunca clínico frio, nunca vendedor
- Idioma: português brasileiro
- Se a foto estiver pouco nítida ou o rosto não estiver visível claramente, ainda assim gere uma análise baseada no questionário`
              }
            ]
          }]
        })
      });

      if (!claudeRes.ok) {
        const err = await claudeRes.text();
        console.error('Claude API error:', err);
        return new Response(JSON.stringify({ error: 'Erro na análise' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      }

      const claudeData = await claudeRes.json();
      const text = claudeData.content[0].text;

      // Extrai JSON da resposta
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error('JSON não encontrado na resposta');

      const analysis = JSON.parse(jsonMatch[0]);

      return new Response(JSON.stringify(analysis), {
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        }
      });

    } catch (err) {
      console.error('Worker error:', err);
      return new Response(JSON.stringify({ error: err.message }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }
  }
};
