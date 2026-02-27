import { Skill, DepedencyLayer, S } from '@m4trix/core';

type LayerDepType = {
  subFoo: string;
};

const layer = DepedencyLayer.of({
  name: 'searchInfo',
  config: S.Struct({
    query: S.String,
  }),
}).define<LayerDepType>();

export const searchInfoSkill = Skill.of()
  .dependsOn(layer)
  .input(S.String)
  .chunk(S.String)
  .done(S.Struct({ result: S.String }))
  .define(({ input, layers }) => {
    const { config } = layers.searchInfo;
    return { result: config.query };
  });
