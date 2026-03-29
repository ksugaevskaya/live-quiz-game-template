import { WebSocketServer } from "ws";
import { WSMessage, User, Game } from "./types";

const PORT = process.env.PORT ? parseInt(process.env.PORT) : 3000;

const users: User[] = [];
const games: Game[] = [];
let userIdCounter = 1;
let gameIdCounter = 1;

function broadcastToGame(gameId: string, type: string, data: any) {
  const game = games.find((g) => g.id === gameId);
  if (!game) return;

  const message = JSON.stringify({ type, data, id: 0 });
  game.players.forEach((player) => {
    if (player.ws?.readyState === 1) {
      player.ws.send(message);
    }
  });

  const hostUser = users.find((u) => u.index === game.hostId);
  if (hostUser?.ws?.readyState === 1) {
    hostUser.ws.send(message);
  }
}

function startQuestionTimer(gameId: string) {
  const game = games.find((g) => g.id === gameId);
  if (!game) return;

  const question = game.questions[game.currentQuestion!];
  const timeLimitMs = question.timeLimitSec * 1000;

  game.questionTimer = setTimeout(() => {
    const playerResults = game.players.map((player) => {
      const answer = game.playerAnswers.get(player.index);
      const correct = answer && answer.answerIndex === question.correctIndex;
      let pointsEarned = 0;

      if (answer) {
        const answerTimestamp = answer.timestamp;
        const timeTaken = (answerTimestamp - game.questionStartTime!) / 1000;
        const remainingTime = Math.max(0, question.timeLimitSec - timeTaken);

        if (correct) {
          pointsEarned = Math.round(
            1000 * (remainingTime / question.timeLimitSec),
          );
        }

        player.score += pointsEarned;
      }

      return {
        name: player.name,
        answered: !!answer,
        correct: !!correct,
        pointsEarned,
        totalScore: player.score,
      };
    });

    broadcastToGame(gameId, "question_result", {
      questionIndex: game.currentQuestion,
      correctIndex: question.correctIndex,
      playerResults,
    });

    game.playerAnswers.clear();

    if (game.currentQuestion! < game.questions.length - 1) {
      setTimeout(() => {
        game.currentQuestion!++;
        game.questionStartTime = Date.now();

        const nextQuestion = game.questions[game.currentQuestion!];
        broadcastToGame(gameId, "question", {
          questionNumber: game.currentQuestion! + 1,
          totalQuestions: game.questions.length,
          text: nextQuestion.text,
          options: nextQuestion.options,
          timeLimitSec: nextQuestion.timeLimitSec,
        });

        startQuestionTimer(gameId);
      }, 3000);
    } else {
      setTimeout(() => {
        const sortedPlayers = [...game.players].sort(
          (a, b) => b.score - a.score,
        );
        const scoreboard = sortedPlayers.map((p, idx) => ({
          name: p.name,
          score: p.score,
          rank: idx + 1,
        }));

        broadcastToGame(gameId, "game_finished", { scoreboard });
        game.status = "finished";
      }, 3000);
    }
  }, timeLimitMs);
}

// WebSocket server
const wss = new WebSocketServer({ port: PORT });

wss.on("connection", (ws, request) => {
  console.log("Client connected");

  ws.on("message", (message) => {
    const req: WSMessage = JSON.parse(message.toString());
    console.log("Received:", req);

    if (req.type === "reg") {
      const { name, password } = req.data;

      let user = users.find((u) => u.name === name && u.password === password);

      if (!user) {
        user = {
          name,
          password,
          index: String(userIdCounter++),
          ws,
        };
        users.push(user);
      } else {
        user.ws = ws;
      }

      ws.send(
        JSON.stringify({
          type: "reg",
          data: {
            name: user.name,
            index: user.index,
            error: false,
            errorText: "",
          },
          id: 0,
        }),
      );
    }

    if (req.type === "create_game") {
      const { questions } = req.data;
      const user = users.find((u) => u.ws === ws);

      if (user) {
        const gameId = String(gameIdCounter++);
        const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
        let code = "";
        for (let i = 0; i < 6; i++) {
          code += chars.charAt(Math.floor(Math.random() * chars.length));
        }

        const game: Game = {
          id: gameId,
          code,
          hostId: user.index,
          questions,
          players: [],
          currentQuestion: -1,
          status: "waiting",
          playerAnswers: new Map(),
        };

        games.push(game);

        ws.send(
          JSON.stringify({
            type: "game_created",
            data: {
              gameId,
              code,
            },
            id: 0,
          }),
        );
      }
    }

    if (req.type === "join_game") {
      const { code } = req.data;
      const user = users.find((u) => u.ws === ws);
      const game = games.find((g) => g.code === code);

      if (user && game) {
        const player = {
          name: user.name,
          index: user.index,
          score: 0,
          ws,
        };

        game.players.push(player);

        ws.send(
          JSON.stringify({
            type: "game_joined",
            data: {
              gameId: game.id,
            },
            id: 0,
          }),
        );

        broadcastToGame(game.id, "player_joined", {
          playerName: user.name,
          playerCount: game.players.length,
        });

        const playersList = game.players.map((p) => ({
          name: p.name,
          index: p.index,
          score: p.score,
        }));
        broadcastToGame(game.id, "update_players", playersList);
      }
    }

    if (req.type === "answer") {
      const { gameId, questionIndex, answerIndex } = req.data;
      const game = games.find((g) => g.id === gameId);
      const user = users.find((u) => u.ws === ws);

      if (game && user) {
        game.playerAnswers.set(user.index, {
          answerIndex,
          timestamp: Date.now(),
        });

        ws.send(
          JSON.stringify({
            type: "answer_accepted",
            data: {
              questionIndex,
            },
            id: 0,
          }),
        );
      }
    }

    if (req.type === "start_game") {
      const { gameId } = req.data;
      const game = games.find((g) => g.id === gameId);
      const user = users.find((u) => u.ws === ws);

      if (game && user && game.hostId === user.index) {
        game.status = "in_progress";
        game.currentQuestion = 0;
        game.questionStartTime = Date.now();

        const question = game.questions[0];
        broadcastToGame(gameId, "question", {
          questionNumber: 1,
          totalQuestions: game.questions.length,
          text: question.text,
          options: question.options,
          timeLimitSec: question.timeLimitSec,
        });

        startQuestionTimer(gameId);
      }
    }
  });

  ws.on("close", () => {
    console.log("Client disconnected");
  });

  ws.on("error", (error) => {
    console.error("WebSocket error:", error);
  });
});
