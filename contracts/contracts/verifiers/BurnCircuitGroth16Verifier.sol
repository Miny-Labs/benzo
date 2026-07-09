// SPDX-License-Identifier: GPL-3.0
/*
    Copyright 2021 0KIMS association.

    This file is generated with [snarkJS](https://github.com/iden3/snarkjs).

    snarkJS is a free software: you can redistribute it and/or modify it
    under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    snarkJS is distributed in the hope that it will be useful, but WITHOUT
    ANY WARRANTY; without even the implied warranty of MERCHANTABILITY
    or FITNESS FOR A PARTICULAR PURPOSE. See the GNU General Public
    License for more details.

    You should have received a copy of the GNU General Public License
    along with snarkJS. If not, see <https://www.gnu.org/licenses/>.
*/

pragma solidity >=0.7.0 <0.9.0;

contract BurnCircuitGroth16Verifier {
    // Scalar field size
    uint256 constant r    = 21888242871839275222246405745257275088548364400416034343698204186575808495617;
    // Base field size
    uint256 constant q   = 21888242871839275222246405745257275088696311157297823662689037894645226208583;

    // Verification Key data
    uint256 constant alphax  = 20491192805390485299153009773594534940189261866228447918068658471970481763042;
    uint256 constant alphay  = 9383485363053290200918347156157836566562967994039712273449902621266178545958;
    uint256 constant betax1  = 4252822878758300859123897981450591353533073413197771768651442665752259397132;
    uint256 constant betax2  = 6375614351688725206403948262868962793625744043794305715222011528459656738731;
    uint256 constant betay1  = 21847035105528745403288232691147584728191162732299865338377159692350059136679;
    uint256 constant betay2  = 10505242626370262277552901082094356697409835680220590971873171140371331206856;
    uint256 constant gammax1 = 11559732032986387107991004021392285783925812861821192530917403151452391805634;
    uint256 constant gammax2 = 10857046999023057135944570762232829481370756359578518086990519993285655852781;
    uint256 constant gammay1 = 4082367875863433681332203403145435568316851327593401208105741076214120093531;
    uint256 constant gammay2 = 8495653923123431417604973247489272438418190587263600148770280649306958101930;
    uint256 constant deltax1 = 14241960243771099266157257893051571269778655095643470863451270529852128267070;
    uint256 constant deltax2 = 16851059822523854459600344068287723915298750311291001617249473043874682645017;
    uint256 constant deltay1 = 11344454503708011003252302859948627165850410785404996086951874153163192361465;
    uint256 constant deltay2 = 9362199881708468108109097562311604543929122892624921601096418380881499225026;

    
    uint256 constant IC0x = 6901175356638081608311197414548846861180656487838344346821425826024891512425;
    uint256 constant IC0y = 16944064565335445729234872967061190126362989003416853826016805426130180238191;
    
    uint256 constant IC1x = 17908121343774581376092646765067170799970925894057937307165335210962871507135;
    uint256 constant IC1y = 6739483966006459958647545663755815825611388802168101513616676265213547687212;
    
    uint256 constant IC2x = 766312427469543414624781412742178740436577019446000599209144238628925292414;
    uint256 constant IC2y = 11956596380120466965959213032841211036588141256244479446912141909087743946449;
    
    uint256 constant IC3x = 9834218022277006635455703178457965188100848955744692108208207593466809819916;
    uint256 constant IC3y = 5985476150835890762503639978680541204908901815001963876083809679448099772187;
    
    uint256 constant IC4x = 14827234556798753501841602996273223453620286706976793196274886644504394417263;
    uint256 constant IC4y = 17185284608112950506629319460803937653685676730131697135772583956246683209368;
    
    uint256 constant IC5x = 17529671244301122497049371127369274616617935801308036584230660946886543200270;
    uint256 constant IC5y = 21375965875653643781871988041044406562099360028820246922430008152355558076267;
    
    uint256 constant IC6x = 2071394549783234155236090578090590694025714713435714686283263242515370887037;
    uint256 constant IC6y = 1360924170815016231172148644602657489538698591468910875031083731851187567999;
    
    uint256 constant IC7x = 10294779462906061052931321788054691400173934802237652306928745571023248394387;
    uint256 constant IC7y = 6555248292739776048079409559973894167013450042783785080733702895769749566613;
    
    uint256 constant IC8x = 4433257889246655161353853222728772973385032114589816543634201923482683435584;
    uint256 constant IC8y = 14737241692493285661348398748630216205024305186831037514190361703045651615269;
    
    uint256 constant IC9x = 14662929317288257322870633955431196105372083992377701985085624881517883523163;
    uint256 constant IC9y = 13045157851276202363238319024416490799176208505845980771766086158756862458455;
    
    uint256 constant IC10x = 10464607531594481747431773960796216724225398526452385781876076453050117351904;
    uint256 constant IC10y = 17227459943128246860971844058080372581110192073599679941420162883374908732283;
    
    uint256 constant IC11x = 745839102907798772556197076666683733791895469218705021459706695701505037999;
    uint256 constant IC11y = 11282995679713265974084133361652481201591627543141168082075682177048149337453;
    
    uint256 constant IC12x = 17929575843708091862123276864146152761508698565499701379217956191629740643940;
    uint256 constant IC12y = 19694868618398715637769102075783868212304717698983166562284533403937378692315;
    
    uint256 constant IC13x = 19788140654052540486857453303544057569825570368720987020309299320004547960581;
    uint256 constant IC13y = 6883822212531810402176678585679740471039138816982867861815020183660906571642;
    
    uint256 constant IC14x = 6016243318855719046735289125777883097005663608233773332990082345142498280371;
    uint256 constant IC14y = 21204516959587943017810864594613242220785397660490599724380523851223540954454;
    
    uint256 constant IC15x = 9891573095652303648634434897797773521123041746620991186215470158961116717665;
    uint256 constant IC15y = 15129361566109667756079905439551006265474721391302786501924664404711249139905;
    
    uint256 constant IC16x = 9439270817025434198507441583978754692817321436471324362734438362897111301924;
    uint256 constant IC16y = 17736726489009951896104159456871058989709210357063650885766330312145063724146;
    
    uint256 constant IC17x = 7287813417026604917333767312326818451716773551965506932628922979658721400484;
    uint256 constant IC17y = 21190069513632277449640126663995547292551888059992765226941465993312580710136;
    
    uint256 constant IC18x = 18870427155174730509179857527710685647524233977259143240992234215761896727263;
    uint256 constant IC18y = 21595208618611453816106702920660402890633778123650117008434425697322727495324;
    
    uint256 constant IC19x = 2474736367332117814843921180480737874685068379574560055026846626150944220277;
    uint256 constant IC19y = 11798959751686284671429858411798094190882362783079508053655067482307321072055;
    
 
    // Memory data
    uint16 constant pVk = 0;
    uint16 constant pPairing = 128;

    uint16 constant pLastMem = 896;

    function verifyProof(uint[2] calldata _pA, uint[2][2] calldata _pB, uint[2] calldata _pC, uint[19] calldata _pubSignals) public view returns (bool) {
        assembly {
            function checkField(v) {
                if iszero(lt(v, r)) {
                    mstore(0, 0)
                    return(0, 0x20)
                }
            }
            
            // G1 function to multiply a G1 value(x,y) to value in an address
            function g1_mulAccC(pR, x, y, s) {
                let success
                let mIn := mload(0x40)
                mstore(mIn, x)
                mstore(add(mIn, 32), y)
                mstore(add(mIn, 64), s)

                success := staticcall(sub(gas(), 2000), 7, mIn, 96, mIn, 64)

                if iszero(success) {
                    mstore(0, 0)
                    return(0, 0x20)
                }

                mstore(add(mIn, 64), mload(pR))
                mstore(add(mIn, 96), mload(add(pR, 32)))

                success := staticcall(sub(gas(), 2000), 6, mIn, 128, pR, 64)

                if iszero(success) {
                    mstore(0, 0)
                    return(0, 0x20)
                }
            }

            function checkPairing(pA, pB, pC, pubSignals, pMem) -> isOk {
                let _pPairing := add(pMem, pPairing)
                let _pVk := add(pMem, pVk)

                mstore(_pVk, IC0x)
                mstore(add(_pVk, 32), IC0y)

                // Compute the linear combination vk_x
                
                g1_mulAccC(_pVk, IC1x, IC1y, calldataload(add(pubSignals, 0)))
                
                g1_mulAccC(_pVk, IC2x, IC2y, calldataload(add(pubSignals, 32)))
                
                g1_mulAccC(_pVk, IC3x, IC3y, calldataload(add(pubSignals, 64)))
                
                g1_mulAccC(_pVk, IC4x, IC4y, calldataload(add(pubSignals, 96)))
                
                g1_mulAccC(_pVk, IC5x, IC5y, calldataload(add(pubSignals, 128)))
                
                g1_mulAccC(_pVk, IC6x, IC6y, calldataload(add(pubSignals, 160)))
                
                g1_mulAccC(_pVk, IC7x, IC7y, calldataload(add(pubSignals, 192)))
                
                g1_mulAccC(_pVk, IC8x, IC8y, calldataload(add(pubSignals, 224)))
                
                g1_mulAccC(_pVk, IC9x, IC9y, calldataload(add(pubSignals, 256)))
                
                g1_mulAccC(_pVk, IC10x, IC10y, calldataload(add(pubSignals, 288)))
                
                g1_mulAccC(_pVk, IC11x, IC11y, calldataload(add(pubSignals, 320)))
                
                g1_mulAccC(_pVk, IC12x, IC12y, calldataload(add(pubSignals, 352)))
                
                g1_mulAccC(_pVk, IC13x, IC13y, calldataload(add(pubSignals, 384)))
                
                g1_mulAccC(_pVk, IC14x, IC14y, calldataload(add(pubSignals, 416)))
                
                g1_mulAccC(_pVk, IC15x, IC15y, calldataload(add(pubSignals, 448)))
                
                g1_mulAccC(_pVk, IC16x, IC16y, calldataload(add(pubSignals, 480)))
                
                g1_mulAccC(_pVk, IC17x, IC17y, calldataload(add(pubSignals, 512)))
                
                g1_mulAccC(_pVk, IC18x, IC18y, calldataload(add(pubSignals, 544)))
                
                g1_mulAccC(_pVk, IC19x, IC19y, calldataload(add(pubSignals, 576)))
                

                // -A
                mstore(_pPairing, calldataload(pA))
                mstore(add(_pPairing, 32), mod(sub(q, calldataload(add(pA, 32))), q))

                // B
                mstore(add(_pPairing, 64), calldataload(pB))
                mstore(add(_pPairing, 96), calldataload(add(pB, 32)))
                mstore(add(_pPairing, 128), calldataload(add(pB, 64)))
                mstore(add(_pPairing, 160), calldataload(add(pB, 96)))

                // alpha1
                mstore(add(_pPairing, 192), alphax)
                mstore(add(_pPairing, 224), alphay)

                // beta2
                mstore(add(_pPairing, 256), betax1)
                mstore(add(_pPairing, 288), betax2)
                mstore(add(_pPairing, 320), betay1)
                mstore(add(_pPairing, 352), betay2)

                // vk_x
                mstore(add(_pPairing, 384), mload(add(pMem, pVk)))
                mstore(add(_pPairing, 416), mload(add(pMem, add(pVk, 32))))


                // gamma2
                mstore(add(_pPairing, 448), gammax1)
                mstore(add(_pPairing, 480), gammax2)
                mstore(add(_pPairing, 512), gammay1)
                mstore(add(_pPairing, 544), gammay2)

                // C
                mstore(add(_pPairing, 576), calldataload(pC))
                mstore(add(_pPairing, 608), calldataload(add(pC, 32)))

                // delta2
                mstore(add(_pPairing, 640), deltax1)
                mstore(add(_pPairing, 672), deltax2)
                mstore(add(_pPairing, 704), deltay1)
                mstore(add(_pPairing, 736), deltay2)


                let success := staticcall(sub(gas(), 2000), 8, _pPairing, 768, _pPairing, 0x20)

                isOk := and(success, mload(_pPairing))
            }

            let pMem := mload(0x40)
            mstore(0x40, add(pMem, pLastMem))

            // Validate that all evaluations ∈ F
            
            checkField(calldataload(add(_pubSignals, 0)))
            
            checkField(calldataload(add(_pubSignals, 32)))
            
            checkField(calldataload(add(_pubSignals, 64)))
            
            checkField(calldataload(add(_pubSignals, 96)))
            
            checkField(calldataload(add(_pubSignals, 128)))
            
            checkField(calldataload(add(_pubSignals, 160)))
            
            checkField(calldataload(add(_pubSignals, 192)))
            
            checkField(calldataload(add(_pubSignals, 224)))
            
            checkField(calldataload(add(_pubSignals, 256)))
            
            checkField(calldataload(add(_pubSignals, 288)))
            
            checkField(calldataload(add(_pubSignals, 320)))
            
            checkField(calldataload(add(_pubSignals, 352)))
            
            checkField(calldataload(add(_pubSignals, 384)))
            
            checkField(calldataload(add(_pubSignals, 416)))
            
            checkField(calldataload(add(_pubSignals, 448)))
            
            checkField(calldataload(add(_pubSignals, 480)))
            
            checkField(calldataload(add(_pubSignals, 512)))
            
            checkField(calldataload(add(_pubSignals, 544)))
            
            checkField(calldataload(add(_pubSignals, 576)))
            

            // Validate all evaluations
            let isValid := checkPairing(_pA, _pB, _pC, _pubSignals, pMem)

            mstore(0, isValid)
             return(0, 0x20)
         }
     }
 }
