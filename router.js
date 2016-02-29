// Babel ES6/JSX Compiler
require('babel-register');
require("babel-polyfill");

var _ = require('underscore');
var xml2js = require('xml2js');
var request = require('request');
var async = require('async');
var Character = require('./models/character');

// https://github.com/alexmingoia/koa-router
var router = require("koa-router")({
  prefix: '/api'
});

router.use(function *(next) {
  this.type = "json";
  yield next;
});

/**
 * GET /api/characters
 * Returns 2 random characters of the same gender that have not been voted yet.
 */
router.get('/characters', function* () {
  var choices = ['Female', 'Male'];
  var randomGender = _.sample(choices);

  yield new Promise((resolve, reject) => {
    Character.find({ random: { $near: [Math.random(), 0] } })
      .where('voted', false)
      .where('gender', randomGender)
      .limit(2)
      .exec((err, characters) => {
        if (err) reject(err);

        if (characters.length === 2) {
          this.body = characters;
          return resolve();
        }

        var oppositeGender = _.first(_.without(choices, randomGender));

        Character
          .find({ random: { $near: [Math.random(), 0] } })
          .where('voted', false)
          .where('gender', oppositeGender)
          .limit(2)
          .exec((err, characters) => {
            if (err) reject(err);

            if (characters.length === 2) {
              this.body = characters;
              return resolve();
            }

            Character.update({}, { $set: { voted: false } }, { multi: true }, (err) => {
              if (err) reject(err);
              this.body = [];
              return resolve();
            });
          });
      });
  });
});

/**
 * PUT /api/characters
 * Update winning and losing count for both characters.
 */
router.put('/characters', function* () {
  var ctx = this;
  var winner = this.request.body.winner;
  var loser = this.request.body.loser;
  if (!winner || !loser) {
    this.status = 400;
    this.body = { message: 'Voting requires two characters.' };
    return;
  }

  if (winner === loser) {
    this.status = 400;
    this.body = { message: 'Cannot vote for and against the same character.' };
    return;
  }

  yield new Promise((resolve, reject) => {
    async.parallel([
      function(callback) {
        Character.findOne({ characterId: winner }, function(err, winner) {
          callback(err, winner);
        });
      },
      function(callback) {
        Character.findOne({ characterId: loser }, function(err, loser) {
          callback(err, loser);
        });
      }
    ], (err, results) => {
      if (err) reject(err);

      var winner = results[0];
      var loser = results[1];

      if (!winner || !loser) {
        ctx.status = 404;
        ctx.body = { message: 'One of the characters no longer exists.' };
        resolve();
      }

      if (winner.voted || loser.voted) {
        ctx.status = 200;
        resolve();
      }

      async.parallel([
        function(callback) {
          winner.wins++;
          winner.voted = true;
          winner.random = [Math.random(), 0];
          winner.save(function(err) {
            callback(err);
          });
        },
        function(callback) {
          loser.losses++;
          loser.voted = true;
          loser.random = [Math.random(), 0];
          loser.save(function(err) {
            callback(err);
          });
        }
      ], function(err) {
        if (err) reject(err);
        ctx.status = 200;
        resolve();
      });
    });
  });
});

/**
 * GET /api/characters/shame
 * Returns 100 lowest ranked characters.
 */
router.get('/characters/shame', function* () {
  yield new Promise((resolve, reject) => {
    Character
      .find()
      .sort('-losses')
      .limit(100)
      .exec((err, characters) => {
        if (err) reject(err);
        this.body = characters;
        resolve();
      });
  });
});

/**
 * GET /api/characters/top
 * Return 100 highest ranked characters. Filter by gender, race and bloodline.
 */
router.get('/characters/top', function* () {
  var params = this.request.query;
  var conditions = {};
  _.each(params, function(value, key) {
    conditions[key] = new RegExp('^' + value + '$', 'i');
  });
  yield new Promise((resolve, reject) => {
    Character
      .find(conditions)
      .sort('-wins')
      .limit(100)
      .exec((err, characters) => {
        if (err) reject(err);

        characters.sort(function(a, b) {
          if (a.wins / (a.wins + a.losses) < b.wins / (b.wins + b.losses)) { return 1; }
          if (a.wins / (a.wins + a.losses) > b.wins / (b.wins + b.losses)) { return -1; }
          return 0;
        });
        this.body = characters;
        resolve();
      });
  });
});

/**
 * GET /api/characters/count [OK]
 * Returns the total number of characters.
 */
router.get('/characters/count', function* () {
  yield new Promise((resolve, reject) => {
    Character.count({}, (err, count) => {
      if (err) reject(err);
      this.body = { count: count };
      resolve();
    });
  });
});

/**
 * GET /api/characters/search
 * Looks up a character by name. (case-insensitive)
 */
router.get('/characters/search', function* () {
  var characterName = new RegExp(this.request.query.name, 'i');

  yield new Promise((resolve, reject) => {
    Character.findOne({ name: characterName }, (err, character) => {
      if (err) reject(err);

      if (!character) {
        this.status = 404;
        this.body = { message: 'Character not found.' };
        return resolve();
      }

      this.body = character;
      resolve();
    });
  });
});

/**
 * GET /api/characters/:id
 * Returns detailed character information.
 */
router.get('/characters/:id', function* () {
  var id = this.params.id;
  yield new Promise((resolve, reject) => {
    Character.findOne({ characterId: id }, (err, character) => {
      if (err) reject(err);

      if (!character) {
        this.status = 404;
        this.body = { message: 'Character not found.' };
        resolve();
      }

      this.body = character;
      resolve();
    });
  });
});

/**
 * POST /api/characters
 * Adds new character to the database.
 */
router.post('/characters', function* () {
  var ctx = this;
  var gender = this.request.body.gender;
  var characterName = this.request.body.name;
  var characterIdLookupUrl = 'https://api.eveonline.com/eve/CharacterID.xml.aspx?names=' + characterName;

  var parser = new xml2js.Parser();

  yield new Promise((resolve, reject) => {
    async.waterfall([
      function(callback) {
        request.get(characterIdLookupUrl, (err, request, xml) => {
          if (err) reject(err);
          parser.parseString(xml, (err, parsedXml) => {
            if (err) reject(err);
            try {
              var characterId = parsedXml.eveapi.result[0].rowset[0].row[0].$.characterID;

              Character.findOne({ characterId: characterId }, (err, character) => {
                if (err) reject(err);

                if (character) {
                  ctx.status = 409;
                  ctx.body = { message: character.name + ' is already in the database.' };
                  return resolve();
                }

                callback(err, characterId);
              });
            } catch (e) {
              ctx.status = 400;
              ctx.body = { message: 'XML Parse Error' };
              reject();
            }
          });
        });
      },
      function(characterId) {
        var characterInfoUrl = 'https://api.eveonline.com/eve/CharacterInfo.xml.aspx?characterID=' + characterId;

        request.get({ url: characterInfoUrl }, (err, request, xml) => {
          if (err) reject(err);
          parser.parseString(xml, function(err, parsedXml) {
            if (err) reject(err);
            try {
              var name = parsedXml.eveapi.result[0].characterName[0];
              var race = parsedXml.eveapi.result[0].race[0];
              var bloodline = parsedXml.eveapi.result[0].bloodline[0];

              var character = new Character({
                characterId: characterId,
                name: name,
                race: race,
                bloodline: bloodline,
                gender: gender,
                random: [Math.random(), 0]
              });

              character.save(function(err) {
                if (err) reject(err);
                ctx.body = { message: characterName + ' has been added successfully!' };
                resolve();
              });
            } catch (e) {
              ctx.status = 404;
              ctx.body = { message: characterName + ' is not a registered citizen of New Eden.' };
              reject();
            }
          });
        });
      }
    ]);
  });
});

/**
 * GET /api/stats [OK]
 * Returns characters statistics.
 */
router.get('/stats', function* () {
  var ctx = this;
  yield new Promise((resolve, reject) => {
    async.parallel([
      function(callback) {
        Character.count({}, function(err, count) {
          callback(err, count);
        });
      },
      function(callback) {
        Character.count({ race: 'Amarr' }, function(err, amarrCount) {
          callback(err, amarrCount);
        });
      },
      function(callback) {
        Character.count({ race: 'Caldari' }, function(err, caldariCount) {
          callback(err, caldariCount);
        });
      },
      function(callback) {
        Character.count({ race: 'Gallente' }, function(err, gallenteCount) {
          callback(err, gallenteCount);
        });
      },
      function(callback) {
        Character.count({ race: 'Minmatar' }, function(err, minmatarCount) {
          callback(err, minmatarCount);
        });
      },
      function(callback) {
        Character.count({ gender: 'Male' }, function(err, maleCount) {
          callback(err, maleCount);
        });
      },
      function(callback) {
        Character.count({ gender: 'Female' }, function(err, femaleCount) {
          callback(err, femaleCount);
        });
      },
      function(callback) {
        Character.aggregate({ $group: { _id: null, total: { $sum: '$wins' } } }, function(err, totalVotes) {
            var total = totalVotes.length ? totalVotes[0].total : 0;
            callback(err, total);
          }
        );
      },
      function(callback) {
        Character
          .find()
          .sort('-wins')
          .limit(100)
          .select('race')
          .exec((err, characters) => {
            if (err) reject(err);

            var raceCount = _.countBy(characters, function(character) { return character.race; });
            var max = _.max(raceCount, function(race) { return race });
            var inverted = _.invert(raceCount);
            var topRace = inverted[max];
            var topCount = raceCount[topRace];

            callback(err, { race: topRace, count: topCount });
          });
      },
      function(callback) {
        Character
          .find()
          .sort('-wins')
          .limit(100)
          .select('bloodline')
          .exec((err, characters) => {
            if (err) reject(err);

            var bloodlineCount = _.countBy(characters, function(character) { return character.bloodline; });
            var max = _.max(bloodlineCount, function(bloodline) { return bloodline });
            var inverted = _.invert(bloodlineCount);
            var topBloodline = inverted[max];
            var topCount = bloodlineCount[topBloodline];

            callback(err, { bloodline: topBloodline, count: topCount });
          });
      }
    ],
    function(err, results) {
      if (err) reject(err);
      ctx.body = {
        totalCount: results[0],
        amarrCount: results[1],
        caldariCount: results[2],
        gallenteCount: results[3],
        minmatarCount: results[4],
        maleCount: results[5],
        femaleCount: results[6],
        totalVotes: results[7],
        leadingRace: results[8],
        leadingBloodline: results[9]
      };
      resolve();
    });
  });
});


/**
 * POST /api/report
 * Reports a character. Character is removed after 4 reports.
 */
router.post('/report', function* () {
  var characterId = this.request.body.characterId;
  yield new Promise((resolve, reject) => {
    Character.findOne({ characterId: characterId }, (err, character) => {
      if (err) reject(err);

      if (!character) {
        this.status = 404;
        this.body = { message: 'Character not found.' };
        resolve();
      }

      character.reports++;

      if (character.reports > 4) {
        character.remove();
        this.body = { message: character.name + ' has been deleted.' };
        resolve();
      }

      character.save((err) => {
        if (err) reject(err);
        this.body = { message: character.name + ' has been reported.' };
        resolve();
      });
    });
  });
});

module.exports = router;
