import { Blocks } from '../dist/easynet/registers.js';

export function controllerFixture() {
  const main = Array(36).fill('0000');
  Object.assign(main, { 18: '0012', 19: '0100', 20: '000c', 21: 'ffce', 22: '0104' });
  const demands = Array(32).fill('0000');
  Object.assign(demands, { 0: '000a', 1: '2710', 3: '07d0', 11: '0001', 12: '0002', 30: '0064' });
  const tanks = Array(34).fill('0000');
  Object.assign(tanks, {
    0: '0110', 1: '00ff', 20: '0115', 21: '0136', 22: '0032',
    23: 'd8f1', 26: '01f4', 27: '0046', 28: '01e7',
  });
  const blocks = new Map([
    [Blocks.main, main], [Blocks.demands, demands], [Blocks.tanks, tanks],
    [Blocks.energyToday, [
      'DIEH=0000', 'DDBEH=0014', 'DBEH=0000', 'DAU=0014', 'DE=0026', 'DCI=0006', 'DAAB=0014',
    ]],
    [Blocks.energyMonth, [
      'MIEH=0000', 'MDEH=001e', 'MBEH=0000', 'MAU=0014', 'ME=02f5', 'MCI=0069', 'MAAB=0014',
    ]],
    [Blocks.alarms, ['get_alarmas=N']],
  ]);
  return {
    blocks, main, demands, tanks,
    registers: new Map([[6100, '0001'], [6101, '0000']]),
    coils: new Map([[1524, '1'], [1552, '1']]),
    async readRegisters() { return this.registers; },
    async readCoils(address) { return new Map([[address, this.coils.get(address)]]); },
    async readBlock(op) { return this.blocks.get(op); },
  };
}
