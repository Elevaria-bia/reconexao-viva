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

    const CORS = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };

    try {
      const { image, scores, userName, userQueixa } = await request.json();

      if (!image) {
        return new Response(JSON.stringify({ error: 'Imagem não recebida' }), { status: 400, headers: CORS });
      }

      // Detecta o formato real da imagem a partir do prefixo data URL
      const mimeMatch = image.match(/^data:(image\/\w+);base64,/);
      const mediaType = (mimeMatch && mimeMatch[1]) || 'image/jpeg';
      const imageData = image.replace(/^data:image\/\w+;base64,/, '');

      // ─── PASSO 1: VALIDAÇÃO RÁPIDA COM HAIKU ────────────────────────────────
      let faceValid = true; // padrão: deixa passar se a API falhar (não penaliza a usuária)

      try {
        const validateRes = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': env.ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 5,
            messages: [{
              role: 'user',
              content: [
                {
                  type: 'image',
                  source: { type: 'base64', media_type: mediaType, data: imageData }
                },
                {
                  type: 'text',
                  text: 'Esta imagem mostra o rosto de um adulto humano (homem ou mulher, maior de 18 anos) claramente visível? Responda APENAS com: SIM ou NAO'
                }
              ]
            }]
          })
        });

        if (validateRes.ok) {
          const validateData = await validateRes.json();
          const answer = (validateData.content?.[0]?.text || '').trim().toUpperCase();
          // Só bloqueia se a resposta for definitivamente NAO
          if (answer.startsWith('NAO') || answer.startsWith('NÃO') || answer === 'NO') {
            faceValid = false;
          }
        }
        // Se validateRes não ok (erro de API): faceValid permanece true — não penaliza a usuária
      } catch(e) {
        console.log('Validação Haiku falhou, prosseguindo:', e.message);
        // faceValid permanece true
      }

      if (!faceValid) {
        return new Response(JSON.stringify({ face_detected: false }), { headers: CORS });
      }

      // ─── PASSO 2: ANÁLISE COMPLETA COM SONNET ───────────────────────────────
      // Só chega aqui se Haiku confirmou que há rosto humano na imagem
      const total = Object.values(scores || {}).reduce((a, b) => a + Number(b), 0) || 10;

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
                source: { type: 'base64', media_type: mediaType, data: imageData }
              },
              {
                type: 'text',
                text: `Você é a Bia, criadora do Método Reconexão Facial — especialista em leitura facial com 15 anos de experiência em estética e consciência corporal.

${userName ? `A mulher na foto se chama ${userName}.` : 'Esta mulher'} acabou de completar o Mapa de Reconexão. Pontuação do questionário: ${total}/15 (5 = mínima tensão, 15 = máxima tensão acumulada).${userQueixa ? `\nEla disse que o que mais a incomoda hoje é: "${userQueixa}". Leve isso em conta na análise.` : ''}

Analise esta foto do rosto com olhar clínico, empático e preciso. Observe:
1. MASSETER E MANDÍBULA — há tensão visível? Assimetria? Sinal de bruxismo?
2. REGIÃO DOS OLHOS — inchaço, olheiras, pesadez nas pálpebras, fadiga
3. TESTA E SOBRANCELHAS — linhas de tensão habitual, franzimento, glabela
4. CONTORNO FACIAL — descida de contorno, pesadez, perda de definição
5. ASSIMETRIA — qual lado carrega mais tensão?
6. EXPRESSÃO EM REPOUSO — o que este rosto comunica quando está quieto?

Retorne SOMENTE este JSON válido, sem markdown:
{
  "face_detected": true,
  "perfil": "Nome poético do perfil desta mulher (2-4 palavras)",
  "titulo": "Uma frase que captura o que este rosto revela (máx 10 palavras)",
  "lead": "2-3 frases sobre o que você observou neste rosto. Específica, não genérica. Tom acolhedor, como amiga que realmente olhou.",
  "cards": [
    { "title": "O que seu rosto revela", "body": "Observação visual específica" },
    { "title": "Onde a tensão mora", "body": "Área de maior acúmulo identificada" },
    { "title": "Seu próximo passo", "body": "Protocolo mais urgente para este padrão" }
  ],
  "transform": "2 frases sobre o que esta mulher pode liberar. Específico para o padrão observado."
}

LINGUAGEM: nunca use anti-envelhecimento, elimine rugas, pareça mais jovem, corrija, conserte.
Use: reconectar, habitar, presença, liberar, amadurecimento, consciência. Idioma: português brasileiro.`
              }
            ]
          }]
        })
      });

      if (!claudeRes.ok) {
        const err = await claudeRes.text();
        console.error('Claude analysis error:', err);
        return new Response(JSON.stringify({ error: 'Erro na análise' }), { status: 500, headers: CORS });
      }

      const claudeData = await claudeRes.json();
      const text = claudeData.content[0].text;

      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error('JSON não encontrado na resposta');

      const analysis = JSON.parse(jsonMatch[0]);

      return new Response(JSON.stringify(analysis), { headers: CORS });

    } catch (err) {
      console.error('Worker error:', err);
      return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: CORS });
    }
  }
};
